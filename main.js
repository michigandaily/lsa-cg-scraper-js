import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { JSDOM } from "jsdom";
import fetch from "node-fetch";
import { autoType, csvFormat, csvParse } from "d3-dsv";
import { rollups, sum, index } from "d3-array";
import { mapLimit } from "async";

const bucket = "stash.michigandaily.com";
const prefix = "course-tracker/winter-2023";

const dateToNearestHour = () => {
  const rounder = 60 * 60 * 1000; // number of milliseconds in an hour
  const now = new Date();
  return new Date(Math.round(now.getTime() / rounder) * rounder).toISOString();
};

/**
 *
 * @param {Map<string,{suffix: string, title: string}>} courses
 * @param {string} term
 * @returns {Promise<Array<{Course: string, Time: string, Section: string, 'Instruction Mode': string, 'Class No': string, 'Enroll Stat': string, 'Open Seats': string, 'Wait List': string, title: string}>>}
 */
const getSections = async (courses, term) => {
  // The prefix for the content query parameter comes from the term.
  // Take EECS 485 for the Winter 2023 semester.
  // The URL is https://lsa.umich.edu/cg/cg_detail.aspx?content=2420EECS485001&termArray=w_23_2420
  // The content query paramter is set as 2420EECS485001
  // The prefix "2420" comes from the term slug "w_23_2420"
  const prefix = term.split("_").at(-1);

  const getCourseSections = async ([name, { suffix, title }]) => {
    const url = new URL("https://www.lsa.umich.edu/cg/cg_detail.aspx");
    url.searchParams.set("content", prefix + name + suffix);
    url.searchParams.set("termArray", term);

    const response = await fetch(url.href);
    if (!response.ok) {
      return [];
    }
    const html = await response.text();
    const { body } = new JSDOM(html).window.document;

    const rows = body.querySelectorAll(".row.clsschedulerow");

    return Array.from(rows).map((row) => {
      const section = { Course: name, Time: dateToNearestHour(), title };
      Array.from(row.querySelectorAll(".row .col-md-1")).forEach((column) => {
        let [key, value] = column.textContent.trim().split(":");
        value = value.trim();
        section[key] = value;
      });
      return section;
    });
  };

  const NUM_OPERATIONS = 25;
  const sections = await mapLimit(
    courses.entries(),
    NUM_OPERATIONS,
    getCourseSections
  );

  return sections.flat();
};

const getCourses = async () => {
  const res = await fetch(`https://${bucket}/${prefix}/cache-courses.csv`);
  if (res.ok) {
    const cache = await res.text();
    return new Map(
      csvParse(cache).map(({ course, suffix, title }) => [course, { suffix, title }])
    );
  } else {
    return null;
  }
};

const getOverview = async () => {
  const res = await fetch(`https://${bucket}/${prefix}/overview.csv`);
  if (res.ok) {
    const overview = await res.text();
    return index(csvParse(overview, autoType), (d) => d.department + d.number);
  } else {
    return null;
  }
};

export const handler = async () => {
  const term = "w_23_2420";

  const courses = await getCourses();
  const sections = await getSections(courses, term);

  const overview = await getOverview();
  const primary = rollups(
    sections.filter(
      (d) =>
        d.Section.includes("LEC") ||
        d.Section.includes("SEM") ||
        d.Section.includes("REC") ||
        d.Section.includes("IND")
    ),
    (v) => {
      const course = v[0].Course;
      const number = +course.slice(-3);
      const available = sum(v, (d) => +d["Open Seats"]);
      let capacity = available;
      if (overview !== null && overview.has(course)) {
        const potential = Number(overview.get(course).capacity);
        if (potential > capacity) {
          capacity = potential;
        }
      }
      const percent_available = available / capacity;
      return {
        department: course.slice(0, -3),
        number,
        title: v[0].title,
        capacity,
        available,
        percent_available,
        waitlist: sum(v, (d) => (d["Wait List"] === "-" ? 0 : +d["Wait List"])),
        undergrad: number < 500,
        studyAbroad: course.includes("STDABRD"),
      };
    },
    (d) => d.Course
  ).map((d) => d[1]);

  const region = "us-east-2";
  const client = new S3Client({ region });
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}/overview.csv`,
      Body: csvFormat(primary),
      ContentType: "text/csv",
      CacheControl: "s-maxage=3500",
    })
  );

  const stub = sections.map(d => ({
    Course: d.Course,
    Time: d.Time,
    Section: d.Section,
    Mode: d["Instruction Mode"],
    Number: d["Class No"],
    Status: d["Enroll Stat"],
    "Open Seats": d["Open Seats"],
    "Wait List": d["Wait List"] === "-" ? 0 : +d["Wait List"]
  }));

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}/stubs/stub-${dateToNearestHour()}.csv`,
      Body: csvFormat(stub),
      ContentType: "text/csv"
    })
  );
};

handler();
