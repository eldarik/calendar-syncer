import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const PROJECT_DIR = process.cwd();
const TOKEN_PATH = path.join(PROJECT_DIR, "token.json");
const CREDENTIALS_PATH = path.join(PROJECT_DIR, "credentials.json");

function parseArgs(argv) {
  const options = {
    calendarId: "primary",
    dryRun: false,
    help: false,
    weeks: 1,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg.startsWith("--calendar=")) {
      const value = arg.slice("--calendar=".length).trim();
      if (!value) {
        throw new Error("The --calendar option requires a non-empty value.");
      }
      options.calendarId = value;
      continue;
    }

    if (arg.startsWith("--weeks=") || arg.startsWith("weeks=")) {
      const value = (arg.startsWith("--weeks=") ? arg.slice("--weeks=".length) : arg.slice("weeks=".length)).trim();
      const weeks = Number.parseInt(value, 10);
      if (!Number.isInteger(weeks) || weeks < 1) {
        throw new Error("The weeks option must be a positive integer (1 or greater).");
      }
      options.weeks = weeks;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run copy-week -- [options]

Options:
  --calendar=<id>  Calendar ID to use (default: primary)
  --weeks=<n>      Number of weeks to copy forward (default: 1)
  weeks=<n>        Same as --weeks (for npm compatibility)
  --dry-run        Show which events would be copied
  --help, -h       Show this help message`);
}

async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH, "utf8");
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch {
    return null;
  }
}

async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH, "utf8");
  const keys = JSON.parse(content);
  const key = keys.installed ?? keys.web;

  if (!key?.client_id || !key?.client_secret) {
    throw new Error("credentials.json is missing client_id or client_secret.");
  }

  const payload = JSON.stringify(
    {
      type: "authorized_user",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    },
    null,
    2,
  );

  await fs.writeFile(TOKEN_PATH, payload, "utf8");
}

async function authorize() {
  const existingClient = await loadSavedCredentialsIfExist();
  if (existingClient) {
    return existingClient;
  }

  const client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  if (client.credentials.refresh_token) {
    await saveCredentials(client);
  }

  return client;
}

function getCurrentWeekRange(now = new Date()) {
  const start = new Date(now);
  const day = start.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + mondayOffset);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  return { start, end };
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getEventStartKey(event) {
  return event.start?.dateTime ?? event.start?.date ?? "missing-start";
}

function getEventEndKey(event) {
  return event.end?.dateTime ?? event.end?.date ?? "missing-end";
}

function getEventIdentity(event) {
  return [
    event.summary ?? "(untitled)",
    normalizeEventBoundary(event.start),
    normalizeEventBoundary(event.end),
  ].join("::");
}

function normalizeEventBoundary(boundary) {
  if (!boundary) {
    return "missing-boundary";
  }

  if (boundary.date) {
    return `date:${boundary.date}`;
  }

  if (!boundary.dateTime) {
    return "missing-datetime";
  }

  return `datetime:${new Date(boundary.dateTime).getTime()}`;
}

function buildCopiedEvent(event, days = 7) {
  const resource = {
    summary: event.summary ?? "(untitled)",
  };

  if (event.description) {
    resource.description = event.description;
  }

  if (event.location) {
    resource.location = event.location;
  }

  if (event.colorId) {
    resource.colorId = event.colorId;
  }

  if (event.start?.date && event.end?.date) {
    resource.start = {
      date: shiftDateOnlyValue(event.start.date, days),
      timeZone: event.start.timeZone,
    };
    resource.end = {
      date: shiftDateOnlyValue(event.end.date, days),
      timeZone: event.end.timeZone,
    };
    return resource;
  }

  if (!event.start?.dateTime || !event.end?.dateTime) {
    throw new Error(
      `Event '${event.summary ?? "(untitled)"}' is missing a supported start/end value.`,
    );
  }

  resource.start = {
    dateTime: shiftRfc3339ByDays(event.start.dateTime, days),
    timeZone: event.start.timeZone,
  };
  resource.end = {
    dateTime: shiftRfc3339ByDays(event.end.dateTime, days),
    timeZone: event.end.timeZone,
  };

  return resource;
}

function shiftDateOnlyValue(dateString, days) {
  const [yearPart, monthPart, dayPart] = dateString.split("-").map(Number);

  if (!yearPart || !monthPart || !dayPart) {
    throw new Error(`Unsupported all-day event date value: ${dateString}`);
  }

  const shifted = new Date(Date.UTC(yearPart, monthPart - 1, dayPart));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function shiftRfc3339ByDays(dateTimeString, days) {
  const match = dateTimeString.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );

  if (!match) {
    throw new Error(`Unsupported dateTime value: ${dateTimeString}`);
  }

  const [, datePart, timePart, fractionPart = "", offsetPart] = match;
  const shiftedDate = shiftDateOnlyValue(datePart, days);
  return `${shiftedDate}T${timePart}${fractionPart}${offsetPart}`;
}

function shouldCopyEvent(event) {
  if (event.status === "cancelled") {
    return false;
  }

  if (!event.start || !event.end) {
    return false;
  }

  if (event.recurringEventId) {
    return false;
  }

  if (event.recurrence?.length) {
    return false;
  }

  if (event.originalStartTime) {
    return false;
  }

  return true;
}

async function listEvents(calendar, calendarId, timeMin, timeMax) {
  const response = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 2500,
  });

  return response.data.items ?? [];
}

async function copyCurrentWeekToNext({ calendarId, dryRun, weeks = 1 }) {
  const auth = await authorize();
  const calendar = google.calendar({ version: "v3", auth });

  const currentWeek = getCurrentWeekRange();
  const [currentWeekEvents] = await Promise.all([
    listEvents(calendar, calendarId, currentWeek.start, currentWeek.end),
  ]);

  const aggregateResults = {
    scanned: currentWeekEvents.length,
    copied: 0,
    skipped: 0,
    duplicates: 0,
    dryRun,
    weeks,
    weeklyDetails: [],
  };

  for (let weekOffset = 1; weekOffset <= weeks; weekOffset++) {
    const daysOffset = weekOffset * 7;
    const targetWeek = {
      start: addDays(currentWeek.start, daysOffset),
      end: addDays(currentWeek.end, daysOffset),
    };

    const targetWeekEvents = await listEvents(
      calendar,
      calendarId,
      targetWeek.start,
      targetWeek.end,
    );

    const existingEventKeys = new Set(targetWeekEvents.map(getEventIdentity));
    const weeklyResult = {
      weekOffset,
      copied: 0,
      skipped: 0,
      duplicates: 0,
    };

    if (!dryRun && weeks > 1) {
      console.log(`Processing week ${weekOffset}...`);
    }

    for (const event of currentWeekEvents) {
      if (!shouldCopyEvent(event)) {
        weeklyResult.skipped += 1;
        continue;
      }

      const copiedEvent = buildCopiedEvent(event, daysOffset);
      const identity = getEventIdentity(copiedEvent);

      if (existingEventKeys.has(identity)) {
        weeklyResult.duplicates += 1;
        continue;
      }

      if (dryRun) {
        console.log(
          `[dry-run] Week ${weekOffset}: Would copy: ${copiedEvent.summary} -> ${getEventStartKey(copiedEvent)}`,
        );
        existingEventKeys.add(identity);
        weeklyResult.copied += 1;
        continue;
      }

      await calendar.events.insert({
        calendarId,
        resource: copiedEvent,
      });

      console.log(
        `Week ${weekOffset}: Copied: ${copiedEvent.summary} -> ${getEventStartKey(copiedEvent)}`,
      );
      existingEventKeys.add(identity);
      weeklyResult.copied += 1;
    }

    aggregateResults.copied += weeklyResult.copied;
    aggregateResults.skipped += weeklyResult.skipped;
    aggregateResults.duplicates += weeklyResult.duplicates;
    aggregateResults.weeklyDetails.push({
      weekOffset,
      start: targetWeek.start.toISOString(),
      end: targetWeek.end.toISOString(),
      ...weeklyResult,
    });
  }

  return {
    currentWeek,
    results: aggregateResults,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  try {
    await fs.access(CREDENTIALS_PATH);
  } catch {
    throw new Error(
      `Missing credentials.json in ${PROJECT_DIR}. Create a Google Cloud desktop OAuth client and save the downloaded file as credentials.json.`,
    );
  }

  const { currentWeek, results } = await copyCurrentWeekToNext(options);

  console.log(`Calendar: ${options.calendarId}`);
  console.log(
    `Current week: ${currentWeek.start.toISOString()} -> ${currentWeek.end.toISOString()}`,
  );

  if (results.weeks === 1) {
    const week = results.weeklyDetails[0];
    console.log(
      `Next week:    ${week.start} -> ${week.end}`,
    );
  } else {
    console.log(`Copying to ${results.weeks} weeks:`);
    results.weeklyDetails.forEach((week) => {
      console.log(`  Week ${week.weekOffset}: ${week.start} -> ${week.end}`);
    });
  }

  console.log(`Scanned: ${results.scanned}`);
  console.log(`Copied: ${results.copied}`);
  console.log(`Skipped: ${results.skipped}`);
  console.log(`Duplicates avoided: ${results.duplicates}`);

  if (results.weeks > 1) {
    console.log(`\nWeekly breakdown:`);
    results.weeklyDetails.forEach((week) => {
      console.log(
        `  Week ${week.weekOffset}: +${week.copied} copied, ${week.duplicates} duplicates avoided`,
      );
    });
  }

  console.log(results.dryRun ? "Mode: dry-run" : "Mode: live");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
