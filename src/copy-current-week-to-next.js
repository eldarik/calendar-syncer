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

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run copy-week -- [options]

Options:
  --calendar=<id>  Calendar ID to use (default: primary)
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

function buildCopiedEvent(event) {
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
      date: shiftDateOnlyValue(event.start.date, 7),
      timeZone: event.start.timeZone,
    };
    resource.end = {
      date: shiftDateOnlyValue(event.end.date, 7),
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
    dateTime: shiftRfc3339ByDays(event.start.dateTime, 7),
    timeZone: event.start.timeZone,
  };
  resource.end = {
    dateTime: shiftRfc3339ByDays(event.end.dateTime, 7),
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

async function copyCurrentWeekToNext({ calendarId, dryRun }) {
  const auth = await authorize();
  const calendar = google.calendar({ version: "v3", auth });

  const currentWeek = getCurrentWeekRange();
  const nextWeek = {
    start: addDays(currentWeek.start, 7),
    end: addDays(currentWeek.end, 7),
  };

  const [currentWeekEvents, nextWeekEvents] = await Promise.all([
    listEvents(calendar, calendarId, currentWeek.start, currentWeek.end),
    listEvents(calendar, calendarId, nextWeek.start, nextWeek.end),
  ]);

  const existingEventKeys = new Set(nextWeekEvents.map(getEventIdentity));
  const results = {
    scanned: currentWeekEvents.length,
    copied: 0,
    skipped: 0,
    duplicates: 0,
    dryRun,
  };

  for (const event of currentWeekEvents) {
    if (!shouldCopyEvent(event)) {
      results.skipped += 1;
      continue;
    }

    const copiedEvent = buildCopiedEvent(event);
    const identity = getEventIdentity(copiedEvent);

    if (existingEventKeys.has(identity)) {
      results.duplicates += 1;
      continue;
    }

    if (dryRun) {
      console.log(
        `[dry-run] Would copy: ${copiedEvent.summary} -> ${getEventStartKey(copiedEvent)}`,
      );
      existingEventKeys.add(identity);
      results.copied += 1;
      continue;
    }

    await calendar.events.insert({
      calendarId,
      resource: copiedEvent,
    });

    existingEventKeys.add(identity);
    results.copied += 1;
  }

  return {
    currentWeek,
    nextWeek,
    results,
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

  const { currentWeek, nextWeek, results } =
    await copyCurrentWeekToNext(options);

  console.log(`Calendar: ${options.calendarId}`);
  console.log(
    `Current week: ${currentWeek.start.toISOString()} -> ${currentWeek.end.toISOString()}`,
  );
  console.log(
    `Next week:    ${nextWeek.start.toISOString()} -> ${nextWeek.end.toISOString()}`,
  );
  console.log(`Scanned: ${results.scanned}`);
  console.log(`Copied: ${results.copied}`);
  console.log(`Skipped: ${results.skipped}`);
  console.log(`Duplicates avoided: ${results.duplicates}`);
  console.log(results.dryRun ? "Mode: dry-run" : "Mode: live");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
