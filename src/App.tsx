import React, { useState } from "react";
import {
  CalendarCheck2,
  Clock3,
  Download,
  Plus,
  Trash2,
  Settings2,
} from "lucide-react";
import "./App.css";

type LoadMode = "relaxed" | "medium" | "marathon";

type AssignmentRow = {
  id: string;
  course: string;
  title: string;
  deadline: string;
  estimatedHours: number;
  priority: number;
  notes: string;
};

type WeeklyObligationRow = {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  label: string;
};

type SpecificObligationRow = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  label: string;
};

type DailyObligationRow = {
  id: string;
  startTime: string;
  endTime: string;
  label: string;
};

type ScheduledEventKind = "task" | "obligation";

type ScheduledEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  kind: ScheduledEventKind;
  course?: string;
  notes?: string;
};

type Settings = {
  timezone: string;
  startDate: string;
  workdayStart: string;
  workdayEnd: string;
  dailyMaxHours: number;
  maxTaskHoursPerDay: number;
  blockMinutes: number;
  breakMinutes: number;
  bufferHours: number;
  workingWeekdays: number[];
  loadMode: LoadMode;
};

type ScheduleResult = {
  events: ScheduledEvent[];
  unscheduled: { title: string; remainingHours: number }[];
};

type SubtaskPhase = {
  label: string;
  plannedMinutes: number;
  remainingMinutes: number;
};

type InternalTask = AssignmentRow & {
  deadlineDate: Date;
  remainingMinutes: number;
  subtasks: string[];
  nextSubIndex: number;
};

const weekdayLabels: { value: number; label: string }[] = [
  { value: 0, label: "ראשון" },
  { value: 1, label: "שני" },
  { value: 2, label: "שלישי" },
  { value: 3, label: "רביעי" },
  { value: 4, label: "חמישי" },
  { value: 5, label: "שישי" },
  { value: 6, label: "שבת" },
];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function parseTimeToMinutes(t: string): number | null {
  const parts = t.split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function normalizeDateString(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // dd.mm.yyyy or dd/mm/yyyy
  const m = trimmed.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, "0");
    const mo = m[2].padStart(2, "0");
    const y = m[3];
    return `${y}-${mo}-${d}`;
  }

  // dd-mm-yyyy
  const m2 = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m2) {
    const d = m2[1].padStart(2, "0");
    const mo = m2[2].padStart(2, "0");
    const y = m2[3];
    return `${y}-${mo}-${d}`;
  }

  return null;
}

function cloneDateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function buildLocalDateTime(date: Date, minutesSinceMidnight: number): Date {
  const hh = Math.floor(minutesSinceMidnight / 60);
  const mm = minutesSinceMidnight % 60;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, 0, 0);
}

// subtract a blocked interval from a list of free windows (all in minutes since midnight)
function subtractInterval(
  windows: Array<[number, number]>,
  block: [number, number]
): Array<[number, number]> {
  const [bs, be] = block;
  if (be <= bs) return windows;
  const out: Array<[number, number]> = [];
  for (const [ws, we] of windows) {
    if (be <= ws || bs >= we) {
      out.push([ws, we]);
      continue;
    }
    if (bs > ws) {
      out.push([ws, Math.min(bs, we)]);
    }
    if (be < we) {
      out.push([Math.max(be, ws), we]);
    }
  }
  return out.filter(([s, e]) => e > s);
}

// ---- ICS helpers ----

function icsEscape(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function formatIcsDateTime(dt: Date): string {
  return (
    dt.getFullYear().toString() +
    pad2(dt.getMonth() + 1) +
    pad2(dt.getDate()) +
    "T" +
    pad2(dt.getHours()) +
    pad2(dt.getMinutes()) +
    pad2(dt.getSeconds())
  );
}

function formatIcsTimestampUtc(dt: Date): string {
  return (
    dt.getUTCFullYear().toString() +
    pad2(dt.getUTCMonth() + 1) +
    pad2(dt.getUTCDate()) +
    "T" +
    pad2(dt.getUTCHours()) +
    pad2(dt.getUTCMinutes()) +
    pad2(dt.getUTCSeconds()) +
    "Z"
  );
}

function buildIcs(events: ScheduledEvent[], timezone: string): string {
  const tzid = timezone || "Asia/Jerusalem";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MahHaloz//Planner//HE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  const stamp = formatIcsTimestampUtc(new Date());
  const sorted = [...events].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0
  );

  sorted.forEach((ev, index) => {
    const [dPart, tPart] = ev.start.split("T");
    const [yy, mm, dd] = dPart.split("-").map(Number);
    const [hh, mn] = tPart.split(":").map(Number);
    const startDt = new Date(yy || 1970, (mm || 1) - 1, dd || 1, hh || 0, mn || 0, 0, 0);

    const [dPart2, tPart2] = ev.end.split("T");
    const [yy2, mm2, dd2] = dPart2.split("-").map(Number);
    const [hh2, mn2] = tPart2.split(":").map(Number);
    const endDt = new Date(yy2 || 1970, (mm2 || 1) - 1, dd2 || 1, hh2 || 0, mn2 || 0, 0, 0);

    const summary = icsEscape(ev.title);
    const desc = icsEscape(ev.notes || "");
    const uid = `event-${index + 1}@mah-haloz`;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;TZID=${tzid}:${formatIcsDateTime(startDt)}`);
    lines.push(`DTEND;TZID=${tzid}:${formatIcsDateTime(endDt)}`);
    lines.push(`SUMMARY:${summary}`);
    if (desc) {
      lines.push(`DESCRIPTION:${desc}`);
    }
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ---- helpers ----

function generateId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
}

function getLoadRatio(mode: LoadMode): number {
  switch (mode) {
    case "relaxed":
      return 0.6;
    case "marathon":
      return 1.0;
    case "medium":
    default:
      return 0.8;
  }
}

// heuristics for default subtasks (when user does not specify)
function proposeSubtasks(estimatedHours: number, title: string): string[] {
  const h = estimatedHours || 0;
  const lowerTitle = title.toLowerCase();
  const isExam =
    lowerTitle.includes("מבחן") ||
    lowerTitle.includes("בוחן") ||
    lowerTitle.includes("exam") ||
    lowerTitle.includes("quiz") ||
    lowerTitle.includes("midterm") ||
    lowerTitle.includes("final");

  if (isExam) {
    if (h <= 2) {
      return ["סקירת חומר", "פתרון שאלות לדוגמה", "חזרה מהירה לפני המבחן"];
    }
    return ["מיפוי נושאים", "פתרון תרגילים", "מבחני ניסיון", "חזרה ממוקדת לפני המבחן"];
  }

  if (h <= 1.5) {
    return ["הבנת דרישות המשימה", "ביצוע וסגירה"];
  }
  if (h <= 3) {
    return ["קריאה ותכנון", "עבודה עיקרית", "בדיקה ושיפורים"];
  }
  return ["תכנון וחלוקת חלקים", "עבודה ראשונית", "העמקה ושיפור", "עריכה והגשה"];
}

/**
 * Parse notes into ordered subtask phases.
 * Supports lines like:
 *   "סקירת ספרות | 3"   (3 hours)
 *   "כתיבת שלד, 2"      (2 hours)
 * If no hours are given, total estimated time is split evenly.
 */
function parseSubtaskPhases(
  notes: string,
  estimatedHours: number,
  title: string
): SubtaskPhase[] {
  const totalFromEstimateMinutes = Math.max(0, Math.round(estimatedHours * 60));

  const rawLines = notes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let labels: string[] = [];
  const hoursHints: Array<number | null> = [];

  if (rawLines.length === 0) {
    const defaults = proposeSubtasks(estimatedHours, title);
    labels = defaults;
    for (let i = 0; i < defaults.length; i += 1) {
      hoursHints.push(null);
    }
  } else {
    const cleaned = rawLines
      .map((l) => l.replace(/^[-*•]\s*/, "").trim())
      .filter((l) => l.length > 0);

    cleaned.forEach((line) => {
      const m = line.match(/^(.*?)[|,]\s*(\d+(?:\.\d+)?)\s*$/);
      if (m) {
        const label = m[1].trim();
        const hoursNum = Number(m[2]);
        if (label) {
          labels.push(label);
          hoursHints.push(Number.isFinite(hoursNum) && hoursNum > 0 ? hoursNum : null);
        }
      } else {
        labels.push(line);
        hoursHints.push(null);
      }
    });
  }

  if (!labels.length) {
    return [];
  }

  const explicitMinutes = hoursHints.map((h) =>
    h && h > 0 ? Math.round(h * 60) : 0
  );
  const totalExplicitMinutes = explicitMinutes.reduce((sum, v) => sum + v, 0);

  let totalMinutes = totalFromEstimateMinutes > 0 ? totalFromEstimateMinutes : totalExplicitMinutes;
  if (totalMinutes === 0) {
    totalMinutes = labels.length * 60;
  }
  if (totalExplicitMinutes > totalMinutes) {
    totalMinutes = totalExplicitMinutes;
  }

  const implicitCount = hoursHints.filter((h) => !h || h <= 0).length;
  const remainingForImplicit = Math.max(0, totalMinutes - totalExplicitMinutes);
  const baseImplicitShare = implicitCount > 0 ? Math.floor(remainingForImplicit / implicitCount) : 0;
  let implicitRemainder = remainingForImplicit - baseImplicitShare * implicitCount;

  const phases: SubtaskPhase[] = [];

  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    const hintHours = hoursHints[i];
    let plannedMinutes: number;

    if (hintHours && hintHours > 0) {
      plannedMinutes = Math.round(hintHours * 60);
    } else {
      plannedMinutes = baseImplicitShare;
      if (implicitRemainder > 0) {
        plannedMinutes += 1;
        implicitRemainder -= 1;
      }
    }

    if (plannedMinutes <= 0) {
      plannedMinutes = 30;
    }

    phases.push({
      label,
      plannedMinutes,
      remainingMinutes: plannedMinutes,
    });
  }

  return phases;
}

// עטיפת תאימות: המרת שלבי־תת־משימה עשירים (SubtaskPhase)
// לרשימת תוויות טקסטואליות בלבד, כפי שהמתזמן מצפה (string[])
function parseSubtaskLabels(
  notes: string,
  estimatedHours: number,
  title: string
): string[] {
  // נניח ש־parseSubtaskPhases מחזירה SubtaskPhase[]
  const phases = (parseSubtaskPhases as any)(notes, estimatedHours, title);

  if (!Array.isArray(phases)) {
    return [];
  }

  const labels = phases
    .map((p: any) => {
      if (typeof p === "string") {
        // במקרה שמישהו שינה את המימוש להחזיר מחרוזות
        return p.trim();
      }
      if (p && typeof p.label === "string") {
        return p.label.trim();
      }
      return "";
    })
    .filter((label: string) => label.length > 0);

  // אם משום מה אין תוויות, נ fallback למבנה הישן
  if (labels.length === 0) {
    return proposeSubtasks(estimatedHours, title);
  }

  return labels;
}

function getEventDurationMinutes(ev: ScheduledEvent): number {
  try {
    const [d1, t1] = ev.start.split("T");
    const [y1, m1, day1] = d1.split("-").map(Number);
    const [h1, min1] = t1.split(":").map(Number);

    const [d2, t2] = ev.end.split("T");
    const [y2, m2, day2] = d2.split("-").map(Number);
    const [h2, min2] = t2.split(":").map(Number);

    const start = new Date(y1, (m1 || 1) - 1, day1 || 1, h1 || 0, min1 || 0, 0, 0);
    const end = new Date(y2, (m2 || 1) - 1, day2 || 1, h2 || 0, min2 || 0, 0, 0);
    const diffMs = end.getTime() - start.getTime();
    const minutes = Math.round(diffMs / (1000 * 60));
    return minutes > 0 ? minutes : 0;
  } catch {
    return 0;
  }
}

// ---- Scheduler ----

function generateSchedule(
  assignments: AssignmentRow[],
  weeklyObligations: WeeklyObligationRow[],
  specificObligations: SpecificObligationRow[],
  dailyObligations: DailyObligationRow[],
  settings: Settings
): ScheduleResult {
  const tasks: InternalTask[] = assignments
    .filter((a) => a.title.trim() && a.estimatedHours > 0 && a.deadline)
    .map((a) => {
      const deadlineDate = new Date(a.deadline + "T23:59:00");
      const remainingMinutes = Math.round(a.estimatedHours * 60);
      const subtasks = parseSubtaskLabels(a.notes, a.estimatedHours, a.title);
      return {
        ...a,
        deadlineDate,
        remainingMinutes,
        subtasks,
        nextSubIndex: 0,
      };
    })
    .filter(
      (a) =>
        !Number.isNaN(a.deadlineDate.getTime()) && a.remainingMinutes > 0
    );

  if (!tasks.length) {
    return { events: [], unscheduled: [] };
  }

  // sort by deadline, then by priority (higher first), then by size
  tasks.sort((a, b) => {
    if (a.deadlineDate.getTime() !== b.deadlineDate.getTime()) {
      return a.deadlineDate.getTime() - b.deadlineDate.getTime();
    }
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return b.remainingMinutes - a.remainingMinutes;
  });

  const startDateObj = cloneDateOnly(
    settings.startDate
      ? new Date(settings.startDate + "T00:00:00")
      : new Date()
  );

  let maxDeadline = cloneDateOnly(tasks[0].deadlineDate);
  for (const t of tasks) {
    const d = cloneDateOnly(t.deadlineDate);
    if (d > maxDeadline) maxDeadline = d;
  }

  const dailyMaxMinutes = Math.round(settings.dailyMaxHours * 60);
  const maxTaskMinutesPerDay = Math.round(settings.maxTaskHoursPerDay * 60);
  const blockMinutes = Math.max(
    15,
    Math.min(240, Math.round(settings.blockMinutes))
  );
  const breakMinutes = Math.max(
    0,
    Math.min(60, Math.round(settings.breakMinutes))
  );
  const bufferMinutes = Math.max(0, Math.round(settings.bufferHours * 60));

  const ratio = getLoadRatio(settings.loadMode || "medium");
  const effectiveDailyMinutes = Math.max(
    30,
    Math.round(dailyMaxMinutes * ratio)
  );
  const effectiveTaskMinutesPerDay = Math.max(
    15,
    Math.round(maxTaskMinutesPerDay * ratio)
  );

  const events: ScheduledEvent[] = [];
  const perDayStudyMinutes: Record<string, number> = {};
  const perTaskPerDayMinutes: Record<string, number> = {};

  function addStudyMinutes(dayKey: string, taskId: string, minutes: number) {
    perDayStudyMinutes[dayKey] =
      (perDayStudyMinutes[dayKey] || 0) + minutes;
    const key = `${taskId}__${dayKey}`;
    perTaskPerDayMinutes[key] =
      (perTaskPerDayMinutes[key] || 0) + minutes;
  }

  function getStudyMinutes(dayKey: string): number {
    return perDayStudyMinutes[dayKey] || 0;
  }

  function getTaskDayMinutes(taskId: string, dayKey: string): number {
    return perTaskPerDayMinutes[`${taskId}__${dayKey}`] || 0;
  }

  const weeklyByDay: Record<number, WeeklyObligationRow[]> = {};
  weeklyObligations.forEach((o) => {
    if (!weeklyByDay[o.weekday]) weeklyByDay[o.weekday] = [];
    weeklyByDay[o.weekday].push(o);
  });

  const specificByDate: Record<string, SpecificObligationRow[]> = {};
  specificObligations.forEach((o) => {
    if (!specificByDate[o.date]) specificByDate[o.date] = [];
    specificByDate[o.date].push(o);
  });

  const workStartMinutes =
    parseTimeToMinutes(settings.workdayStart) ?? 8 * 60;
  const workEndMinutes =
    parseTimeToMinutes(settings.workdayEnd) ?? 20 * 60;
  const workingWeek = new Set(settings.workingWeekdays);

  const dayCount =
    Math.round(
      (maxDeadline.getTime() - startDateObj.getTime()) /
        (24 * 60 * 60 * 1000)
    ) + 1;

  // count how many working days exist in the whole range
  let totalWorkingDays = 0;
  for (let offset = 0; offset < dayCount; offset += 1) {
    const tmpDate = new Date(startDateObj);
    tmpDate.setDate(startDateObj.getDate() + offset);
    if (workingWeek.has(tmpDate.getDay())) {
      totalWorkingDays += 1;
    }
  }
  let workingDayIndex = 0;

  for (let offset = 0; offset < dayCount; offset += 1) {
    const currentDate = new Date(startDateObj);
    currentDate.setDate(startDateObj.getDate() + offset);
    const dKey = dateKey(currentDate);
    const weekday = currentDate.getDay();

    const weekBlocked = weeklyByDay[weekday] || [];
    const specificBlocked = specificByDate[dKey] || [];

    // add obligations to events, for visibility
    weekBlocked.forEach((o) => {
      const sMin = parseTimeToMinutes(o.startTime);
      const eMin = parseTimeToMinutes(o.endTime);
      if (sMin !== null && eMin !== null && eMin > sMin) {
        const sDt = buildLocalDateTime(currentDate, sMin);
        const eDt = buildLocalDateTime(currentDate, eMin);
        events.push({
          id: generateId("obl"),
          kind: "obligation",
          title: o.label || "אילוץ שבועי",
          start: `${dKey}T${pad2(sDt.getHours())}:${pad2(
            sDt.getMinutes()
          )}`,
          end: `${dKey}T${pad2(eDt.getHours())}:${pad2(
            eDt.getMinutes()
          )}`,
          notes: "אילוץ שבועי קבוע",
          course: undefined,
        });
      }
    });

    specificBlocked.forEach((o) => {
      const sMin = parseTimeToMinutes(o.startTime);
      const eMin = parseTimeToMinutes(o.endTime);
      if (sMin !== null && eMin !== null && eMin > sMin) {
        const sDt = buildLocalDateTime(currentDate, sMin);
        const eDt = buildLocalDateTime(currentDate, eMin);
        events.push({
          id: generateId("obl"),
          kind: "obligation",
          title: o.label || "אילוץ בתאריך",
          start: `${dKey}T${pad2(sDt.getHours())}:${pad2(
            sDt.getMinutes()
          )}`,
          end: `${dKey}T${pad2(eDt.getHours())}:${pad2(
            eDt.getMinutes()
          )}`,
          notes: "אילוץ חד פעמי",
          course: undefined,
        });
      }
    });

    // daily obligations (every calendar day)
    dailyObligations.forEach((o) => {
      const sMin = parseTimeToMinutes(o.startTime);
      const eMin = parseTimeToMinutes(o.endTime);
      if (sMin !== null && eMin !== null && eMin > sMin) {
        const sDt = buildLocalDateTime(currentDate, sMin);
        const eDt = buildLocalDateTime(currentDate, eMin);
        events.push({
          id: generateId("obl"),
          kind: "obligation",
          title: o.label || "אילוץ יומי",
          start: `${dKey}T${pad2(sDt.getHours())}:${pad2(
            sDt.getMinutes()
          )}`,
          end: `${dKey}T${pad2(eDt.getHours())}:${pad2(
            eDt.getMinutes()
          )}`,
          notes: "אילוץ יומי קבוע",
          course: undefined,
        });
      }
    });

    if (!workingWeek.has(weekday)) continue;

    // dynamic daily budget based on remaining work and remaining working days,
    // with "cram" behavior when there is risk of not finishing on time
    const remainingMinutesAll = tasks.reduce(
      (sum, t) => sum + t.remainingMinutes,
      0
    );
    if (remainingMinutesAll <= 0) break;

    const remainingWorkingDays = totalWorkingDays - workingDayIndex;
    if (remainingWorkingDays <= 0) break;

    const idealPerDay = remainingMinutesAll / remainingWorkingDays;

    const mode = settings.loadMode || "medium";
    const spreadMultiplier =
      mode === "relaxed" ? 0.75 : mode === "marathon" ? 1.4 : 1.0;

    const baseTarget = idealPerDay * spreadMultiplier;

    const riskRatio =
      effectiveDailyMinutes > 0
        ? remainingMinutesAll /
          (remainingWorkingDays * effectiveDailyMinutes)
        : 0;

    let dailyBudgetMinutes: number;

    if (riskRatio >= 1) {
      // we already need at least the full daily capacity
      // to finish on time -> "cram" behavior
      dailyBudgetMinutes = effectiveDailyMinutes;
    } else {
      // otherwise keep a floor so we do not under-allocate early days
      const minFloor = effectiveDailyMinutes * 0.5;
      dailyBudgetMinutes = Math.min(
        effectiveDailyMinutes,
        Math.max(baseTarget, minFloor)
      );
    }

    if (dailyBudgetMinutes < blockMinutes) {
      dailyBudgetMinutes = blockMinutes;
    }

    workingDayIndex += 1;

    let windows: Array<[number, number]> = [];
    if (workEndMinutes > workStartMinutes) {
      windows.push([workStartMinutes, workEndMinutes]);
    }

    const blockedIntervals: Array<[number, number]> = [];
    weekBlocked.forEach((o) => {
      const s = parseTimeToMinutes(o.startTime);
      const e = parseTimeToMinutes(o.endTime);
      if (s !== null && e !== null && e > s) blockedIntervals.push([s, e]);
    });
    specificBlocked.forEach((o) => {
      const s = parseTimeToMinutes(o.startTime);
      const e = parseTimeToMinutes(o.endTime);
      if (s !== null && e !== null && e > s) blockedIntervals.push([s, e]);
    });
    dailyObligations.forEach((o) => {
      const s = parseTimeToMinutes(o.startTime);
      const e = parseTimeToMinutes(o.endTime);
      if (s !== null && e !== null && e > s) blockedIntervals.push([s, e]);
    });

    blockedIntervals.sort((a, b) => a[0] - b[0]);
    blockedIntervals.forEach((block) => {
      windows = subtractInterval(windows, block);
    });
    windows.sort((a, b) => a[0] - b[0]);
    if (!windows.length) continue;

    let anyTaskRemaining = tasks.some((t) => t.remainingMinutes > 0);
    if (!anyTaskRemaining) break;

    let lastTaskIdForDay: string | null = null;

    for (const [winStart, winEnd] of windows) {
      let cursor = winStart;

      while (cursor < winEnd) {
        anyTaskRemaining = tasks.some((t) => t.remainingMinutes > 0);
        if (!anyTaskRemaining) break;

        const remainingWindowMinutes = winEnd - cursor;
        if (remainingWindowMinutes < 10) break;

        const baseBlock = Math.min(blockMinutes, remainingWindowMinutes);

        const dayStudiedNow = getStudyMinutes(dKey);
        if (dayStudiedNow >= dailyBudgetMinutes) break;

        const candidateIndices: number[] = [];
        for (let i = 0; i < tasks.length; i += 1) {
          const t = tasks[i];
          if (t.remainingMinutes <= 0) continue;

          const dayStudied = getStudyMinutes(dKey);
          if (dayStudied >= dailyBudgetMinutes) continue;

          const taskDayStudied = getTaskDayMinutes(t.id, dKey);
          if (taskDayStudied >= effectiveTaskMinutesPerDay) continue;

          const allocCandidate = Math.min(baseBlock, t.remainingMinutes);
          if (allocCandidate < 10) continue;

          if (dayStudied + allocCandidate > dailyBudgetMinutes) continue;
          if (
            taskDayStudied + allocCandidate >
            effectiveTaskMinutesPerDay
          )
            continue;

          const slotEndDtCandidate = buildLocalDateTime(
            currentDate,
            cursor + allocCandidate
          );
          const deadlineWithBuffer = new Date(
            t.deadlineDate.getTime() - bufferMinutes * 60 * 1000
          );
          if (
            slotEndDtCandidate.getTime() >
            deadlineWithBuffer.getTime()
          )
            continue;

          candidateIndices.push(i);
        }

        if (!candidateIndices.length) break;

        // urgency + priority + remaining work + diversity
        const scored = candidateIndices.map((idx) => {
          const t = tasks[idx];
          const msDiff =
            t.deadlineDate.getTime() - currentDate.getTime();
          const daysDiff = msDiff / (1000 * 60 * 60 * 24);
          const urgency =
            daysDiff <= 0 ? 10 : Math.min(10, 10 / daysDiff);
          const priorityScore = t.priority;
          const remainingBlocks = t.remainingMinutes / blockMinutes;
          const scoreBase =
            urgency * 2 + priorityScore + remainingBlocks * 0.1;
          const diversityPenalty =
            lastTaskIdForDay && t.id === lastTaskIdForDay ? 0.5 : 1;
          return { idx, score: scoreBase * diversityPenalty };
        });

        scored.sort((a, b) => b.score - a.score);

        let chosenIndex = scored[0].idx;
        if (
          lastTaskIdForDay !== null &&
          scored.length > 1 &&
          tasks[chosenIndex].id === lastTaskIdForDay
        ) {
          const alternative = scored.find(
            (s) => tasks[s.idx].id !== lastTaskIdForDay
          );
          if (alternative) {
            chosenIndex = alternative.idx;
          }
        }

        const task = tasks[chosenIndex];
        const alloc = Math.min(baseBlock, task.remainingMinutes);
        const slotStartDt = buildLocalDateTime(currentDate, cursor);
        const slotEndDt = buildLocalDateTime(
          currentDate,
          cursor + alloc
        );

        const startStr = `${dKey}T${pad2(
          slotStartDt.getHours()
        )}:${pad2(slotStartDt.getMinutes())}`;
        const endStr = `${dKey}T${pad2(slotEndDt.getHours())}:${pad2(
          slotEndDt.getMinutes()
        )}`;

        const subtaskLabel =
          task.subtasks.length > 0
            ? task.subtasks[task.nextSubIndex]
            : "";
        if (task.subtasks.length > 0) {
          task.nextSubIndex =
            (task.nextSubIndex + 1) % task.subtasks.length;
        }

        const titleBase = `${
          task.course ? task.course + " • " : ""
        }${task.title}`;
        const fullTitle = subtaskLabel
          ? `${titleBase} – ${subtaskLabel}`
          : titleBase;

        const notesParts = [
          `דדליין: ${task.deadline.replace(/-/g, "/")}`,
          `עדיפות: ${task.priority}`,
          `בלוק: ${alloc} דקות`,
        ];
        if (subtaskLabel) {
          notesParts.push(`תת משימה: ${subtaskLabel}`);
        }
        if (task.notes.trim()) {
          notesParts.push(task.notes);
        }
        const notes = notesParts.filter(Boolean).join("\n");

        events.push({
          id: generateId("task"),
          kind: "task",
          title: fullTitle,
          start: startStr,
          end: endStr,
          course: task.course,
          notes,
        });

        task.remainingMinutes -= alloc;
        addStudyMinutes(dKey, task.id, alloc);
        lastTaskIdForDay = task.id;
        cursor += alloc + breakMinutes;
      }
    }
  }

  const unscheduled = tasks
    .filter((t) => t.remainingMinutes > 0)
    .map((t) => ({
      title: `${t.course ? t.course + " • " : ""}${t.title}`,
      remainingHours: Number((t.remainingMinutes / 60).toFixed(1)),
    }));

  events.sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0
  );

  return { events, unscheduled };
}

// ---- React app ----

const App: React.FC = () => {
  const today = new Date();
  const todayStr = dateKey(today);

  const [settings, setSettings] = useState<Settings>({
    timezone: "Asia/Jerusalem",
    startDate: todayStr,
    workdayStart: "08:00",
    workdayEnd: "20:00",
    dailyMaxHours: 6,
    maxTaskHoursPerDay: 3,
    blockMinutes: 90,
    breakMinutes: 15,
    bufferHours: 24,
    workingWeekdays: [0, 1, 2, 3, 4],
    loadMode: "medium",
  });

  const [assignments, setAssignments] = useState<AssignmentRow[]>([
    {
      id: generateId("as"),
      course: "קורס לדוגמה",
      title: "עבודה מסכמת",
      deadline: todayStr,
      estimatedHours: 6,
      priority: 4,
      notes: "סקירת ספרות | 3\nכתיבת שלד | 2\nעריכה והגשה | 1",
    },
  ]);

  const [pasteInput, setPasteInput] = useState<string>("");
  const [pasteFeedback, setPasteFeedback] = useState<string | null>(null);

  const [weeklyObligations, setWeeklyObligations] = useState<WeeklyObligationRow[]>([
    {
      id: generateId("wo"),
      weekday: 0,
      startTime: "21:30",
      endTime: "22:30",
      label: "טיול עם הכלב",
    },
  ]);

  const [specificObligations, setSpecificObligations] = useState<SpecificObligationRow[]>(
    []
  );

  const [dailyObligations, setDailyObligations] = useState<DailyObligationRow[]>([
    {
      id: generateId("do"),
      startTime: "13:30",
      endTime: "14:00",
      label: "ארוחת צהריים יומית",
    },
  ]);

  const [activeStep, setActiveStep] = useState<number>(1);
  const [showIntro, setShowIntro] = useState<boolean>(true);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState<boolean>(false);

  const [result, setResult] = useState<ScheduleResult | null>(null);
  const [icsContent, setIcsContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [scheduleApproved, setScheduleApproved] = useState<boolean>(false);
  const [hasDownloadedOnce, setHasDownloadedOnce] = useState<boolean>(false);
  const [showGCalGuide, setShowGCalGuide] = useState<boolean>(false);

  const steps = [
    { id: 1, label: "הגדרות" },
    { id: 2, label: "קורסים ומטלות" },
    { id: 3, label: "אילוצים" },
    { id: 4, label: "לו״ז וייצוא" },
  ];

  const largeInputStyle: React.CSSProperties = {
    fontSize: "0.95rem",
    padding: "0.55rem 0.75rem",
  };

  // table handlers

  const updateAssignment = (id: string, patch: Partial<AssignmentRow>) => {
    setAssignments((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const removeAssignment = (id: string) => {
    setAssignments((rows) => rows.filter((r) => r.id !== id));
  };
  const addAssignment = () => {
    setAssignments((rows) => [
      ...rows,
      {
        id: generateId("as"),
        course: "",
        title: "",
        deadline: settings.startDate,
        estimatedHours: 2,
        priority: 3,
        notes: "",
      },
    ]);
  };

  const handlePasteAssignments = () => {
    setPasteFeedback(null);
    const raw = pasteInput.trim();
    if (!raw) {
      setPasteFeedback("לא הוזן טקסט להדבקה.");
      return;
    }

    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let added = 0;
    let skippedInvalid = 0;
    let skippedDuplicates = 0;

    setAssignments((prev) => {
      const existingKeys = new Set(
        prev.map((a) => `${a.course}|||${a.title}|||${a.deadline}`)
      );
      const newRows: AssignmentRow[] = [];

      for (const line of lines) {
        const cleanLine = line.replace(/^["']+|["']+$/g, "");

        const cells = cleanLine
          .split(/[\t,;|]/)
          .map((c) => c.replace(/^["']+|["']+$/g, "").trim())
          .filter((c) => c.length > 0);

        if (cells.length < 3) {
          skippedInvalid += 1;
          continue;
        }

        const [courseCell, titleCell, deadlineCellRaw] = cells;
        const deadlineCell = deadlineCellRaw.replace(/["']/g, "").trim();

        if (!courseCell || !titleCell || !deadlineCell) {
          skippedInvalid += 1;
          continue;
        }

        const lowerCourse = courseCell.toLowerCase();
        const lowerTitle = titleCell.toLowerCase();
        if (
          lowerCourse.includes("קורס") &&
          (lowerTitle.includes("מטלה") || lowerTitle.includes("assignment"))
        ) {
          continue;
        }

        const normalizedDeadline = normalizeDateString(deadlineCell);
        if (!normalizedDeadline) {
          skippedInvalid += 1;
          continue;
        }

        const key = `${courseCell}|||${titleCell}|||${normalizedDeadline}`;
        if (existingKeys.has(key)) {
          skippedDuplicates += 1;
          continue;
        }

        existingKeys.add(key);

        newRows.push({
          id: generateId("as"),
          course: courseCell,
          title: titleCell,
          deadline: normalizedDeadline,
          estimatedHours: 2,
          priority: 3,
          notes: "",
        });
        added += 1;
      }

      return [...prev, ...newRows];
    });

    let msg = `נוספו ${added} שורות מטבלה.`;
    if (skippedDuplicates > 0) {
      msg += ` דילגנו על ${skippedDuplicates} כפילויות.`;
    }
    if (skippedInvalid > 0) {
      msg += ` לא נוספו ${skippedInvalid} שורות בשל בעיות בפורמט.`;
    }
    setPasteFeedback(msg);
    setPasteInput("");
  };

  const updateWeeklyObligation = (id: string, patch: Partial<WeeklyObligationRow>) => {
    setWeeklyObligations((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const removeWeeklyObligation = (id: string) => {
    setWeeklyObligations((rows) => rows.filter((r) => r.id !== id));
  };
  const addWeeklyObligation = () => {
    setWeeklyObligations((rows) => [
      ...rows,
      {
        id: generateId("wo"),
        weekday: 0,
        startTime: "13:00",
        endTime: "14:00",
        label: "אילוץ חדש",
      },
    ]);
  };

  const updateSpecificObligation = (id: string, patch: Partial<SpecificObligationRow>) => {
    setSpecificObligations((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const removeSpecificObligation = (id: string) => {
    setSpecificObligations((rows) => rows.filter((r) => r.id !== id));
  };
  const addSpecificObligation = () => {
    setSpecificObligations((rows) => [
      ...rows,
      {
        id: generateId("so"),
        date: settings.startDate,
        startTime: "18:00",
        endTime: "19:00",
        label: "אירוע חד פעמי",
      },
    ]);
  };

  const updateDailyObligation = (id: string, patch: Partial<DailyObligationRow>) => {
    setDailyObligations((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const removeDailyObligation = (id: string) => {
    setDailyObligations((rows) => rows.filter((r) => r.id !== id));
  };
  const addDailyObligation = () => {
    setDailyObligations((rows) => [
      ...rows,
      {
        id: generateId("do"),
        startTime: "20:00",
        endTime: "20:30",
        label: "אילוץ יומי חדש",
      },
    ]);
  };

  const toggleWeekday = (weekday: number) => {
    setSettings((prev) => {
      const set = new Set(prev.workingWeekdays);
      if (set.has(weekday)) set.delete(weekday);
      else set.add(weekday);
      return { ...prev, workingWeekdays: Array.from(set).sort() };
    });
  };

  const handleGenerate = () => {
    // נקה מצב קודם באופן מפורש לפני יצירת לו״ז חדש
    setError(null);
    setScheduleApproved(false);
    setHasDownloadedOnce(false);
    setResult(null);
    setIcsContent(null);

    const hasValid = assignments.some(
      (a) => a.title.trim() && a.deadline && a.estimatedHours > 0
    );

    if (!hasValid) {
      setError("יש להזין לפחות מטלה אחת עם דדליין ושעות משוערות.");
      return;
    }

    // יצירת הלו״ז מחדש לפי ההגדרות והמטלות העדכניות
    const schedule = generateSchedule(
      assignments,
      weeklyObligations,
      specificObligations,
      dailyObligations,
      settings
    );

    setResult(schedule);

    if (!schedule.events.length) {
      setError("לא נוצרו בלוקים. עדכן/י שעות עבודה, אילוצים או דדליינים.");
      return;
    }

    const ics = buildIcs(schedule.events, settings.timezone);
    setIcsContent(ics);
  };

  const handleDownloadIcs = () => {
    if (!icsContent || !scheduleApproved) return;
    const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "schedule.ics";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setHasDownloadedOnce(true);
  };

  const exitIntro = () => {
    setShowIntro(false);
    setActiveStep(1);
  };

  // derived course summary for Step 4
  const courseSummary =
    result && result.events.length > 0
      ? (() => {
          const map: Record<
            string,
            { totalMinutes: number; days: Set<string>; taskEvents: number }
          > = {};
          result.events.forEach((ev) => {
            if (ev.kind !== "task") return;
            const courseName = ev.course && ev.course.trim().length > 0 ? ev.course : "ללא קורס";
            if (!map[courseName]) {
              map[courseName] = {
                totalMinutes: 0,
                days: new Set<string>(),
                taskEvents: 0,
              };
            }
            const minutes = getEventDurationMinutes(ev);
            map[courseName].totalMinutes += minutes;
            const [dPart] = ev.start.split("T");
            map[courseName].days.add(dPart);
            map[courseName].taskEvents += 1;
          });
          return Object.entries(map).map(([course, data]) => ({
            course,
            totalMinutes: data.totalMinutes,
            distinctDays: data.days.size,
            taskEvents: data.taskEvents,
          }));
        })()
      : [];

  return (
    <div className="app-root" dir="rtl">
      <header className="app-header">
        <div className="header-left">
          <div className="header-icon">
            <CalendarCheck2 size={24} />
          </div>
          <div>
            <h1 className="app-title">מה הלו״ז??</h1>
            <p className="app-subtitle">
              מתכנן לו״ז חכם לסטודנטים: מטלות, דדליינים, אילוצים וייצוא ל־Google Calendar.
            </p>
          </div>
        </div>
        <div className="header-right">
          <Clock3 size={16} />
          <span>אזור זמן: {settings.timezone || "Asia/Jerusalem"}</span>
        </div>
      </header>

      <main className="app-main">
        {showIntro ? (
          <section className="card intro-card">
            <h2 className="card-title">ברוכים הבאים ל־"מה הלו״ז??"</h2>
            <p className="card-desc">
              האפליקציה עוזרת לך לתכנן לו״ז אקדמי חכם בעברית מלאה, לפי קורסים, מטלות, אילוצים
              אישיים ומצב עומס מועדף.
            </p>
            <ul className="intro-list">
              <li>הזנת קורסים ומטלות עם דדליינים והערכה לשעות עבודה.</li>
              <li>קביעת אילוצים שבועיים, יומיים ותאריכים מיוחדים כמו מבחנים.</li>
              <li>חלוקה לתתי משימות לפי סדר הגיוני בתוך כל מטלה.</li>
              <li>ייצוא ללו״ז ב־Google Calendar בקובץ .ics.</li>
            </ul>
            <div className="intro-actions">
              <button type="button" className="primary" onClick={exitIntro}>
                בואו נתחיל
              </button>
            </div>
          </section>
        ) : (
          <>
            <nav className="stepper">
              {steps.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  className={
                    step.id === activeStep ? "step-button step-button-active" : "step-button"
                  }
                  onClick={() => setActiveStep(step.id)}
                >
                  <span className="step-number">{step.id}</span>
                  <span>{step.label}</span>
                </button>
              ))}
            </nav>

            {/* Step 1: settings */}
            {activeStep === 1 && (
              <section className="card">
                <h2 className="card-title">הגדרות בסיס</h2>
                <p className="card-desc">
                  בחר/י אזור זמן, תאריך התחלה, חלון עבודה יומי ומצב עומס. אפשר לפתוח גם הגדרות
                  מתקדמות למי שמעדיפ/ה שליטה מלאה.
                </p>
                <div className="grid-two">
                  <div className="field-group">
                    <label>אזור זמן (TZID)</label>
                    <input
                      style={largeInputStyle}
                      value={settings.timezone}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, timezone: e.target.value.trim() }))
                      }
                      placeholder="Asia/Jerusalem"
                    />
                    <small>נכנס כ־TZID בקובץ ה־ICS (IANA).</small>
                  </div>
                  <div className="field-group">
                    <label>תאריך התחלה</label>
                    <input
                      type="date"
                      style={largeInputStyle}
                      value={settings.startDate}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, startDate: e.target.value }))
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>שעת התחלה יומית</label>
                    <input
                      type="time"
                      style={largeInputStyle}
                      value={settings.workdayStart}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, workdayStart: e.target.value }))
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>שעת סיום יומית</label>
                    <input
                      type="time"
                      style={largeInputStyle}
                      value={settings.workdayEnd}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, workdayEnd: e.target.value }))
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>מקסימום שעות עבודה ביום</label>
                    <input
                      type="number"
                      style={largeInputStyle}
                      min={1}
                      max={12}
                      step={0.5}
                      value={settings.dailyMaxHours}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          dailyMaxHours: Number(e.target.value) || 0,
                        }))
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>מצב עומס מועדף</label>
                    <select
                      style={largeInputStyle}
                      value={settings.loadMode}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          loadMode: e.target.value as LoadMode,
                        }))
                      }
                    >
                      <option value="relaxed">מצב רגוע</option>
                      <option value="medium">עומס בינוני</option>
                      <option value="marathon">מצב מרתון</option>
                    </select>
                    <small>
                      מצב רגוע מפזר עבודה במתינות לאורך הימים. מצב בינוני מאזן בין ניצול הזמן
                      להפחתת עומס. מצב מרתון מנצל את המקסימום שהגדרת, כדי לסיים מוקדם יותר.
                    </small>
                    <div className="workload-info small">
                      <div className="bold">איך מצב העומס משפיע בפועל?</div>
                      <p>
                        האלגוריתם מחשב כמות עבודה יומית אידיאלית לפי כמות הזמן שנותרה עד
                        הדדליינים ומפחית או מגביר אותה לפי מצב העומס. כך הלו״ז מרגיש מותאם
                        אישית לקצב הלמידה שלך.
                      </p>
                    </div>
                  </div>
                  <div className="field-group full-width">
                    <label>ימים שבהם מותר לשבץ מטלות</label>
                    <div className="weekday-toggle-row">
                      {weekdayLabels.map((w) => (
                        <button
                          key={w.value}
                          type="button"
                          className={
                            settings.workingWeekdays.includes(w.value)
                              ? "weekday-pill weekday-pill-active"
                              : "weekday-pill"
                          }
                          onClick={() => toggleWeekday(w.value)}
                        >
                          {w.label}
                        </button>
                      ))}
                    </div>
                    <small>לדוגמה, אפשר להשבית שישי ושבת.</small>
                  </div>
                </div>

                <div className="advanced-toggle-row">
                  <button
                    type="button"
                    className={`secondary advanced-toggle ${
                      showAdvancedSettings ? "advanced-toggle-open" : ""
                    }`}
                    onClick={() => setShowAdvancedSettings((prev: boolean) => !prev)}
                  >
                    <Settings2 size={14} />
                    {showAdvancedSettings ? "הסתר הגדרות מתקדמות" : "הצגת הגדרות מתקדמות"}
                  </button>

                </div>

                {showAdvancedSettings && (
                  <div className="grid-two advanced-panel">
                    <div className="field-group">
                      <label>מקסימום שעות לאותה מטלה ביום</label>
                      <input
                        type="number"
                        style={largeInputStyle}
                        min={1}
                        max={8}
                        step={0.5}
                        value={settings.maxTaskHoursPerDay}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            maxTaskHoursPerDay: Number(e.target.value) || 0,
                          }))
                        }
                      />
                      <small>מגביל כמה זמן רצוף תהיה עם אותה מטלה באותו יום.</small>
                    </div>
                    <div className="field-group">
                      <label>אורך בלוק עבודה (דקות)</label>
                      <input
                        type="number"
                        style={largeInputStyle}
                        min={15}
                        max={240}
                        step={15}
                        value={settings.blockMinutes}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            blockMinutes: Number(e.target.value) || 0,
                          }))
                        }
                      />
                      <small>לדוגמה 60 או 90 דקות לבלוק לימוד אחד.</small>
                    </div>
                    <div className="field-group">
                      <label>הפסקה בין בלוקים (דקות)</label>
                      <input
                        type="number"
                        style={largeInputStyle}
                        min={0}
                        max={60}
                        step={5}
                        value={settings.breakMinutes}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            breakMinutes: Number(e.target.value) || 0,
                          }))
                        }
                      />
                      <small>הפסקה קבועה אחרי כל בלוק עבודה שהלו״ז ייצור.</small>
                    </div>
                    <div className="field-group">
                      <label>מרווח ביטחון לפני דדליין (שעות)</label>
                      <input
                        type="number"
                        style={largeInputStyle}
                        min={0}
                        max={96}
                        step={12}
                        value={settings.bufferHours}
                        onChange={(e) =>
                          setSettings((s) => ({
                            ...s,
                            bufferHours: Number(e.target.value) || 0,
                          }))
                        }
                      />
                      <small>מונע קביעת בלוקים בדקות האחרונות לפני הדדליין.</small>
                    </div>
                  </div>
                )}

                <div className="card-footer">
                  <span className="muted">שלב 1 מתוך 4</span>
                  <button type="button" className="primary" onClick={() => setActiveStep(2)}>
                    המשך למטלות
                  </button>
                </div>
              </section>
            )}

            {/* Step 2: assignments */}
            {activeStep === 2 && (
              <section className="card">
                <div className="card-header-row">
                  <div>
                    <h2 className="card-title">קורסים ומטלות</h2>
                    <p className="card-desc">
                      כל שורה מייצגת מטלה גדולה. אפשר לפרט תתי משימות בשדה ההערות, כולל הערכת
                      זמן לכל תת משימה. האלגוריתם יסיים שלב אחד לפני שיעבור לשלב הבא באותה
                      מטלה.
                    </p>
                  </div>
                  <button type="button" className="secondary" onClick={addAssignment}>
                    <Plus size={14} />
                    הוספת מטלה
                  </button>
                </div>

                {/* פאנל הדבקת טבלה מגיליון - אופציונלי */}
                <div className="paste-panel">
                  <label className="small bold">ייבוא מטלות מגיליון (אופציונלי)</label>
                  <textarea
                    value={pasteInput}
                    onChange={(e) => setPasteInput(e.target.value)}
                    placeholder={
                      "הדבק כאן טבלה מ־Sheets או Excel.\nכל שורה צריכה לכלול: קורס, מטלה, דדליין (לדוגמה 22.02.2026).\nמותר להשתמש בטאב, פסיק, נקודה־פסיק או קו אנכי (|) בין העמודות."
                    }
                  />

                  <div className="paste-example small muted">
                    דוגמה לקלט תקין (שורה אחת לכל מטלה):
                    <br />
                    <code>
                      סמינריון מחקר ביולוגי | כתיבת פרק ראשון | 22.02.2026
                    </code>
                    <br />
                    <code>
                      סמינריון מחקר ביולוגי | כתיבת פרק שני | 01.03.2026
                    </code>
                    <br />
                    <span>
                      אפשר גם להשתמש בטאב או בפסיקים במקום בקו אנכי. התאריכים יכולים להיות
                      בפורמט 22.02.2026 או 2026-02-22.
                    </span>
                  </div>

                  <div className="paste-panel-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={handlePasteAssignments}
                    >
                      ניתוח הטבלה והוספה למטלות
                    </button>
                    {pasteFeedback && <span className="small muted">{pasteFeedback}</span>}
                  </div>
                </div>

                <div className="table-wrapper table-wrapper-assignments">
                  <table className="data-table data-table-assignments">
                    <thead>
                      <tr>
                        <th>קורס</th>
                        <th>מטלה</th>
                        <th>דדליין</th>
                        <th>שעות</th>
                        <th>עדיפות</th>
                        <th>הערות / תתי משימות</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {assignments.map((row) => (
                        <tr key={row.id}>
                          <td data-label="קורס">
                            <input
                              value={row.course}
                              onChange={(e) =>
                                updateAssignment(row.id, { course: e.target.value })
                              }
                            />
                          </td>
                          <td data-label="מטלה">
                            <input
                              value={row.title}
                              onChange={(e) =>
                                updateAssignment(row.id, { title: e.target.value })
                              }
                            />
                          </td>
                          <td data-label="דדליין">
                            <input
                              type="date"
                              value={row.deadline}
                              onChange={(e) =>
                                updateAssignment(row.id, { deadline: e.target.value })
                              }
                            />
                          </td>
                          <td data-label="שעות" className="narrow">
                            <input
                              type="number"
                              min={0}
                              step={0.5}
                              value={row.estimatedHours}
                              onChange={(e) =>
                                updateAssignment(row.id, {
                                  estimatedHours: Number(e.target.value) || 0,
                                })
                              }
                            />
                          </td>
                          <td data-label="עדיפות" className="narrow">
                            <select
                              value={row.priority}
                              onChange={(e) =>
                                updateAssignment(row.id, {
                                  priority: Number(e.target.value) || 3,
                                })
                              }
                            >
                              {[1, 2, 3, 4, 5].map((p) => (
                                <option key={p} value={p}>
                                  {p}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td data-label="הערות / תתי משימות">
                            <textarea
                              value={row.notes}
                              onChange={(e) =>
                                updateAssignment(row.id, { notes: e.target.value })
                              }
                              placeholder={
                                "אפשר לכתוב תתי משימות לפי סדר העבודה, כל שורה כשלב נפרד.\nכדי להעריך זמן לתת משימה, השתמש/י בפורמט:\nסקירת ספרות | 3   (שלוש שעות)\nכתיבת שלד | 2\nעריכה והגשה | 1"
                              }
                            />
                          </td>
                          <td data-label="פעולות" className="icon-cell">
                            <button
                              type="button"
                              className="danger-icon"
                              onClick={() => removeAssignment(row.id)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {assignments.length === 0 && (
                        <tr>
                          <td colSpan={7} className="muted center">
                            אין מטלות כרגע. הוסף/י שורה חדשה.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="card-footer">
                  <button type="button" className="secondary" onClick={() => setActiveStep(1)}>
                    חזרה להגדרות
                  </button>
                  <button type="button" className="primary" onClick={() => setActiveStep(3)}>
                    המשך לאילוצים
                  </button>
                </div>
              </section>
            )}

            {/* Step 3: constraints */}
            {activeStep === 3 && (
              <section className="card">
                <div className="card-header-row">
                  <div>
                    <h2 className="card-title">אילוצים</h2>
                    <p className="card-desc">
                      חלונות תפוסים שבהם אסור לשבץ מטלות. לדוגמה עבודה, שיעורים, טיול עם הכלב,
                      ארוחת צהריים או חדר כושר.
                    </p>
                  </div>
                </div>

                <div className="constraints-grid">
                  <div>
                    <div className="constraints-header">
                      <h3>אילוצים שבועיים</h3>
                      <button
                        type="button"
                        className="secondary"
                        onClick={addWeeklyObligation}
                      >
                        <Plus size={14} />
                        אילוץ שבועי
                      </button>
                    </div>
                    <div className="constraints-list">
                      {weeklyObligations.map((o) => (
                        <div key={o.id} className="constraint-card">
                          <div className="constraint-row">
                            <select
                              value={o.weekday}
                              onChange={(e) =>
                                updateWeeklyObligation(o.id, {
                                  weekday: Number(e.target.value) || 0,
                                })
                              }
                            >
                              {weekdayLabels.map((w) => (
                                <option key={w.value} value={w.value}>
                                  {w.label}
                                </option>
                              ))}
                            </select>
                            <input
                              type="time"
                              value={o.startTime}
                              onChange={(e) =>
                                updateWeeklyObligation(o.id, { startTime: e.target.value })
                              }
                            />
                            <span>עד</span>
                            <input
                              type="time"
                              value={o.endTime}
                              onChange={(e) =>
                                updateWeeklyObligation(o.id, { endTime: e.target.value })
                              }
                            />
                            <button
                              type="button"
                              className="danger-icon"
                              onClick={() => removeWeeklyObligation(o.id)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <input
                            value={o.label}
                            onChange={(e) =>
                              updateWeeklyObligation(o.id, { label: e.target.value })
                            }
                            placeholder="שם האילוץ, לדוגמה: עבודה, חוג..."
                          />
                        </div>
                      ))}
                      {weeklyObligations.length === 0 && (
                        <div className="muted small">
                          עדיין אין אילוצים שבועיים. הוסף/י לדוגמה שיעור קבוע או עבודה.
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="constraints-header">
                      <h3>אילוצים בתאריכים ספציפיים</h3>
                      <button
                        type="button"
                        className="secondary"
                        onClick={addSpecificObligation}
                      >
                        <Plus size={14} />
                        אילוץ בתאריך
                      </button>
                    </div>
                    <div className="constraints-list">
                      {specificObligations.map((o) => (
                        <div key={o.id} className="constraint-card">
                          <div className="constraint-row">
                            <input
                              type="date"
                              value={o.date}
                              onChange={(e) =>
                                updateSpecificObligation(o.id, { date: e.target.value })
                              }
                            />
                            <input
                              type="time"
                              value={o.startTime}
                              onChange={(e) =>
                                updateSpecificObligation(o.id, { startTime: e.target.value })
                              }
                            />
                            <span>עד</span>
                            <input
                              type="time"
                              value={o.endTime}
                              onChange={(e) =>
                                updateSpecificObligation(o.id, { endTime: e.target.value })
                              }
                            />
                            <button
                              type="button"
                              className="danger-icon"
                              onClick={() => removeSpecificObligation(o.id)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <input
                            value={o.label}
                            onChange={(e) =>
                              updateSpecificObligation(o.id, { label: e.target.value })
                            }
                            placeholder="לדוגמה: מבחן, אירוע משפחתי, רופא..."
                          />
                        </div>
                      ))}
                      {specificObligations.length === 0 && (
                        <div className="muted small">
                          אין אילוצים חד פעמיים כרגע. אם יש מבחנים או אירועים, הוסף/י אותם כאן.
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="constraints-header">
                      <h3>אילוצים יומיים</h3>
                      <button type="button" className="secondary" onClick={addDailyObligation}>
                        <Plus size={14} />
                        אילוץ יומי
                      </button>
                    </div>
                    <div className="constraints-list">
                      {dailyObligations.map((o) => (
                        <div key={o.id} className="constraint-card">
                          <div className="constraint-row">
                            <input
                              type="time"
                              value={o.startTime}
                              onChange={(e) =>
                                updateDailyObligation(o.id, { startTime: e.target.value })
                              }
                            />
                            <span>עד</span>
                            <input
                              type="time"
                              value={o.endTime}
                              onChange={(e) =>
                                updateDailyObligation(o.id, { endTime: e.target.value })
                              }
                            />
                            <button
                              type="button"
                              className="danger-icon"
                              onClick={() => removeDailyObligation(o.id)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <input
                            value={o.label}
                            onChange={(e) =>
                              updateDailyObligation(o.id, { label: e.target.value })
                            }
                            placeholder="לדוגמה: ארוחת צהריים, טיול עם הכלב, חדר כושר..."
                          />
                        </div>
                      ))}
                      {dailyObligations.length === 0 && (
                        <div className="muted small">
                          אין אילוצים יומיים כרגע. אם יש הרגלים יומיומיים, הוסף/י אותם כאן.
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="card-footer">
                  <button type="button" className="secondary" onClick={() => setActiveStep(2)}>
                    חזרה למטלות
                  </button>
                  <button type="button" className="primary" onClick={() => setActiveStep(4)}>
                    המשך ללו״ז
                  </button>
                </div>
              </section>
            )}

            {/* Step 4: results */}
            {activeStep === 4 && (
              <section className="card">
                <div className="card-header-row">
                  <div>
                    <h2 className="card-title">לו״ז וייצוא</h2>
                    <p className="card-desc">
                      הלו״ז מחלק את הזמן לפי מצב העומס, הדדליינים ותתי המשימות. בתוך כל מטלה
                      תת משימה אחת מסתיימת לפני שהבאה אחריה מתחילה. אפשר לאשר ואחר כך להוריד
                      קובץ ICS.
                    </p>
                  </div>
                  <div className="result-actions">
                    <button type="button" className="primary" onClick={handleGenerate}>
                      <Settings2 size={14} />
                      יצירת לו״ז
                    </button>
                    <button
                      type="button"
                      className={
                        result && result.events.length > 0 && !scheduleApproved
                          ? "secondary"
                          : "secondary disabled"
                      }
                      onClick={() => {
                        if (result && result.events.length > 0) {
                          setScheduleApproved(true);
                        }
                      }}
                      disabled={!result || result.events.length === 0 || scheduleApproved}
                    >
                      {scheduleApproved ? "הלו״ז אושר" : "אישור הלו״ז"}
                    </button>
                    <button
                      type="button"
                      className={
                        icsContent && scheduleApproved ? "secondary" : "secondary disabled"
                      }
                      onClick={handleDownloadIcs}
                      disabled={!icsContent || !scheduleApproved}
                    >
                      <Download size={14} />
                      {hasDownloadedOnce ? "הורדת קובץ .ics מעודכן" : "הורדת קובץ .ics"}
                    </button>
                  </div>
                </div>

                <div className="gcal-guide">
                  <button
                    type="button"
                    className="secondary guide-button"
                    onClick={() => setShowGCalGuide((prev) => !prev)}
                  >
                    {showGCalGuide
                      ? "הסתר מדריך הוספה ל־Google Calendar"
                      : "מדריך מצולם: הוספת הקובץ ל־Google Calendar"}
                  </button>

                  {showGCalGuide && (
                    <div className="gcal-guide-card">
                      <h3 className="gcal-guide-title">
                        יצירת לוח שנה חדש ב־Google Calendar וייבוא קובץ ה־ICS
                      </h3>
                      <ol className="gcal-guide-list">
                        <li>
                          <strong>מסך הבית של Google Calendar.</strong>
                          <p className="small muted">
                            היכנס/י ל־calendar.google.com בחשבון הגוגל שלך. ודא/י שאת/ה רואה את
                            מסך לוח השנה הראשי.
                          </p>
                          <img src="/gcal-step-1.png" alt="מסך הבית של Google Calendar" />
                        </li>

                        <li>
                          <strong>פתיחת התפריט הצף ב&quot;יומנים אחרים&quot;.</strong>
                          <p className="small muted">
                            בצד שמאל, רחף/י עם העכבר מעל האזור &quot;יומנים אחרים&quot; ולחץ/י
                            על סימן הפלוס (+). בתפריט הצף, אפשרות &quot;יצירת לוח שנה
                            חדש&quot; מסומנת.
                          </p>
                          <img
                            src="/gcal-step-2.png"
                            alt='פתיחת התפריט הצף ב"יומנים אחרים" עם "יצירת לוח שנה חדש" מסומן'
                          />
                        </li>

                        <li>
                          <strong>טופס יצירת לוח שנה חדש.</strong>
                          <p className="small muted">
                            בחלון &quot;יצירת לוח שנה חדש&quot;, הקלד/י שם ברור, למשל{" "}
                            <span className="bold">"לו״ז לימודים – סמסטר ב״"</span>, ואז לחץ/י
                            על כפתור &quot;יצירת לוח שנה&quot;.
                          </p>
                          <img
                            src="/gcal-step-3.png"
                            alt='טופס יצירת לוח שנה חדש עם שם "לו״ז לימודים – סמסטר ב״" וכפתור יצירת לוח שנה מסומן'
                          />
                        </li>

                        <li>
                          <strong>בחירת &quot;ייבוא ויצוא&quot;.</strong>
                          <p className="small muted">
                            לאחר יצירת לוח השנה, בחלון ההגדרות, בחר/י בתפריט הצד &quot;ייבוא
                            ויצוא&quot; כך שהאפשרות מסומנת ומודגשת.
                          </p>
                          <img
                            src="/gcal-step-4.png"
                            alt='חלון ההגדרות עם "ייבוא ויצוא" מסומן בתפריט הצד'
                          />
                        </li>

                        <li>
                          <strong>טופס ייבוא – בחירת קובץ ה־ICS.</strong>
                          <p className="small muted">
                            באזור &quot;ייבוא&quot;, לחץ/י על כפתור &quot;בחר קובץ&quot; (או
                            &quot;Upload&quot;) ובחר/י את קובץ ה־ICS שהורדת מהאפליקציה.
                          </p>
                          <img
                            src="/gcal-step-5.png"
                            alt="טופס ייבוא ב־Google Calendar עם כפתור בחירת הקובץ מסומן"
                          />
                        </li>

                        <li>
                          <strong>טופס ייבוא – בחירת לוח השנה המתאים.</strong>
                          <p className="small muted">
                            בשדה &quot;הוסף אל לוח שנה&quot;, פתח/י את תפריט הבחירה ובחר/י את
                            לוח השנה שיצרת קודם, למשל &quot;לו״ז לימודים – סמסטר ב״&quot;.
                          </p>
                          <img
                            src="/gcal-step-6.png"
                            alt="טופס ייבוא ב־Google Calendar עם תפריט בחירת לוח השנה מסומן"
                          />
                        </li>

                        <li>
                          <strong>טופס ייבוא – לחיצה על &quot;ייבוא&quot;.</strong>
                          <p className="small muted">
                            לאחר שבחרת קובץ ל־ICS ולוח שנה מתאים, לחץ/י על כפתור &quot;ייבוא&quot;
                            כדי להכניס את כל האירועים לקלנדר.
                          </p>
                          <img
                            src="/gcal-step-7.png"
                            alt='טופס ייבוא לאחר בחירת קובץ ולוח שנה, כפתור "ייבוא" מסומן'
                          />
                        </li>

                        <li>
                          <strong>מסך הבית עם האירועים החדשים.</strong>
                          <p className="small muted">
                            חזור/י למסך הבית של Google Calendar, ודא/י שלוח השנה החדש מסומן בצד
                            שמאל, ובדוק/י שהאירועים מהקובץ מופיעים בימים ובשעות שנקבעו
                            באפליקציה.
                          </p>
                          <img
                            src="/gcal-step-8.png"
                            alt="מסך הבית של Google Calendar לאחר הייבוא, האירועים החדשים מופיעים"
                          />
                        </li>
                      </ol>
                    </div>
                  )}
                </div>

                {error && <div className="error-box">{error}</div>}

                {result && (
                  <>
                    <div className="summary-row">
                      <span>סה&quot;כ אירועים: {result.events.length}</span>
                      <span>מספר מטלות: {assignments.length}</span>
                      {result.unscheduled.length > 0 && (
                        <span>מטלות שלא שובצו: {result.unscheduled.length}</span>
                      )}
                      {!scheduleApproved && result.events.length > 0 && (
                        <span>יש לאשר את הלו״ז לפני הורדה.</span>
                      )}
                    </div>

                    {courseSummary.length > 0 && (
                      <div className="course-summary">
                        <h3 className="course-summary-title">חלוקת זמן לפי קורס</h3>
                        <div className="course-summary-grid">
                          {courseSummary.map((c) => (
                            <div key={c.course} className="course-summary-card">
                              <div className="course-summary-course">{c.course}</div>
                              <div className="course-summary-line">
                                סה&quot;כ שעות משובצות:{" "}
                                {Number((c.totalMinutes / 60).toFixed(1))}
                              </div>
                              <div className="course-summary-line">
                                ימים שונים בלו״ז: {c.distinctDays}
                              </div>
                              <div className="course-summary-line">
                                מספר בלוקים למטלות הקורס: {c.taskEvents}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {result.unscheduled.length > 0 && (
                      <div className="warning-box">
                        <p className="bold">מטלות שלא נכנסו ללו״ז במסגרת ההגבלות:</p>
                        <ul>
                          {result.unscheduled.map((u) => (
                            <li key={u.title}>
                              {u.title} ({u.remainingHours} שעות שנותרו)
                            </li>
                          ))}
                        </ul>
                        <small>
                          אפשר להגדיל את מקסימום השעות ביום, לאפשר עוד ימים, או לצמצם מרווחי
                          ביטחון.
                        </small>
                      </div>
                    )}

                    <div className="table-wrapper">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>סוג</th>
                            <th>כותרת</th>
                            <th>תאריך</th>
                            <th>שעת התחלה</th>
                            <th>שעת סיום</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.events.map((ev) => {
                            const [dPart, tPart] = ev.start.split("T");
                            const [d2, t2] = ev.end.split("T");
                            const dateLabel = dPart.split("-").reverse().join("/");
                            const dateLabelEnd =
                              d2 && d2 !== dPart ? d2.split("-").reverse().join("/") : "";
                            return (
                              <tr key={ev.id}>
                                <td>
                                  {ev.kind === "task" ? (
                                    <span className="badge-task">מטלה</span>
                                  ) : (
                                    <span className="badge-obligation">אילוץ</span>
                                  )}
                                </td>
                                <td>{ev.title}</td>
                                <td>
                                  {dateLabel}
                                  {dateLabelEnd && ` → ${dateLabelEnd}`}
                                </td>
                                <td>{tPart}</td>
                                <td>{t2}</td>
                              </tr>
                            );
                          })}
                          {result.events.length === 0 && (
                            <tr>
                              <td colSpan={5} className="center muted">
                                טרם נוצרו אירועים. יש ללחוץ על הכפתור יצירת לו״ז.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {!result && (
                  <div className="info-box">
                    כדי לראות תוצאה, ודא/י שהזנת מטלות ואילוצים ולאחר מכן לחץ/י על הכפתור
                    יצירת לו״ז. לאחר מכן יש לאשר את הלו״ז ורק אז להוריד קובץ ICS.
                  </div>
                )}

                <div className="card-footer">
                  <button type="button" className="secondary" onClick={() => setActiveStep(1)}>
                    חזרה לעריכה
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </main>

      <footer className="app-footer">
        מה הלו״ז?? · מתכנן לו״ז אקדמי בעברית מלאה · חלוקת בלוקים לפי מצב עומס · יצוא ל־Google
        Calendar באמצעות קובץ ICS
      </footer>
    </div>
  );
};

export default App;