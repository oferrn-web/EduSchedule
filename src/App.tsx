import React, { useState } from "react";
import { CalendarCheck2, Clock3, Download, Plus, Trash2, Settings2 } from "lucide-react";
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

// ---- AI-style helpers ----

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

// exam-aware default subtasks
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

function parseSubtaskLabels(notes: string, estimatedHours: number, title: string): string[] {
  if (!notes.trim()) {
    return proposeSubtasks(estimatedHours, title);
  }
  const rawLines = notes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const cleaned = rawLines
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l.length > 0);

  if (cleaned.length >= 2) {
    return cleaned;
  }
  return proposeSubtasks(estimatedHours, title);
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
    .filter((a) => !Number.isNaN(a.deadlineDate.getTime()) && a.remainingMinutes > 0);

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
    settings.startDate ? new Date(settings.startDate + "T00:00:00") : new Date()
  );

  let maxDeadline = cloneDateOnly(tasks[0].deadlineDate);
  for (const t of tasks) {
    const d = cloneDateOnly(t.deadlineDate);
    if (d > maxDeadline) maxDeadline = d;
  }

  const dailyMaxMinutes = Math.round(settings.dailyMaxHours * 60);
  const maxTaskMinutesPerDay = Math.round(settings.maxTaskHoursPerDay * 60);
  const blockMinutes = Math.max(15, Math.min(240, Math.round(settings.blockMinutes)));
  const breakMinutes = Math.max(0, Math.min(60, Math.round(settings.breakMinutes)));
  const bufferMinutes = Math.max(0, Math.round(settings.bufferHours * 60));

  const ratio = getLoadRatio(settings.loadMode || "medium");
  const effectiveDailyMinutes = Math.max(30, Math.round(dailyMaxMinutes * ratio));
  const effectiveTaskMinutesPerDay = Math.max(15, Math.round(maxTaskMinutesPerDay * ratio));

  const events: ScheduledEvent[] = [];
  const perDayStudyMinutes: Record<string, number> = {};
  const perTaskPerDayMinutes: Record<string, number> = {};

  function addStudyMinutes(dayKey: string, taskId: string, minutes: number) {
    perDayStudyMinutes[dayKey] = (perDayStudyMinutes[dayKey] || 0) + minutes;
    const key = `${taskId}__${dayKey}`;
    perTaskPerDayMinutes[key] = (perTaskPerDayMinutes[key] || 0) + minutes;
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

  const workStartMinutes = parseTimeToMinutes(settings.workdayStart) ?? 8 * 60;
  const workEndMinutes = parseTimeToMinutes(settings.workdayEnd) ?? 20 * 60;
  const workingWeek = new Set(settings.workingWeekdays);

  const dayCount =
    Math.round((maxDeadline.getTime() - startDateObj.getTime()) / (24 * 60 * 60 * 1000)) + 1;

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
          start: `${dKey}T${pad2(sDt.getHours())}:${pad2(sDt.getMinutes())}`,
          end: `${dKey}T${pad2(eDt.getHours())}:${pad2(eDt.getMinutes())}`,
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
          start: `${dKey}T${pad2(sDt.getHours())}:${pad2(sDt.getMinutes())}`,
          end: `${dKey}T${pad2(eDt.getHours())}:${pad2(eDt.getMinutes())}`,
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
          start: `${dKey}T${pad2(sDt.getHours())}:${pad2(sDt.getMinutes())}`,
          end: `${dKey}T${pad2(eDt.getHours())}:${pad2(eDt.getMinutes())}`,
          notes: "אילוץ יומי קבוע",
          course: undefined,
        });
      }
    });

    if (!workingWeek.has(weekday)) continue;

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
        if (dayStudiedNow >= effectiveDailyMinutes) break;

        const candidateIndices: number[] = [];
        for (let i = 0; i < tasks.length; i += 1) {
          const t = tasks[i];
          if (t.remainingMinutes <= 0) continue;

          const dayStudied = getStudyMinutes(dKey);
          if (dayStudied >= effectiveDailyMinutes) continue;

          const taskDayStudied = getTaskDayMinutes(t.id, dKey);
          if (taskDayStudied >= effectiveTaskMinutesPerDay) continue;

          const allocCandidate = Math.min(baseBlock, t.remainingMinutes);
          if (allocCandidate < 10) continue;

          if (dayStudied + allocCandidate > effectiveDailyMinutes) continue;
          if (taskDayStudied + allocCandidate > effectiveTaskMinutesPerDay) continue;

          const slotEndDtCandidate = buildLocalDateTime(
            currentDate,
            cursor + allocCandidate
          );
          const deadlineWithBuffer = new Date(
            t.deadlineDate.getTime() - bufferMinutes * 60 * 1000
          );
          if (slotEndDtCandidate.getTime() > deadlineWithBuffer.getTime()) continue;

          candidateIndices.push(i);
        }

        if (!candidateIndices.length) break;

        // urgency + priority + remaining work + diversity
        const scored = candidateIndices.map((idx) => {
          const t = tasks[idx];
          const msDiff = t.deadlineDate.getTime() - currentDate.getTime();
          const daysDiff = msDiff / (1000 * 60 * 60 * 24);
          const urgency = daysDiff <= 0 ? 10 : Math.min(10, 10 / daysDiff);
          const priorityScore = t.priority;
          const remainingBlocks = t.remainingMinutes / blockMinutes;
          const scoreBase = urgency * 2 + priorityScore + remainingBlocks * 0.1;
          const diversityPenalty = lastTaskIdForDay && t.id === lastTaskIdForDay ? 0.5 : 1;
          return { idx, score: scoreBase * diversityPenalty };
        });

        scored.sort((a, b) => b.score - a.score);

        let chosenIndex = scored[0].idx;
        if (
          lastTaskIdForDay !== null &&
          scored.length > 1 &&
          tasks[chosenIndex].id === lastTaskIdForDay
        ) {
          const alternative = scored.find((s) => tasks[s.idx].id !== lastTaskIdForDay);
          if (alternative) {
            chosenIndex = alternative.idx;
          }
        }

        const task = tasks[chosenIndex];
        const alloc = Math.min(baseBlock, task.remainingMinutes);
        const slotStartDt = buildLocalDateTime(currentDate, cursor);
        const slotEndDt = buildLocalDateTime(currentDate, cursor + alloc);

        const startStr = `${dKey}T${pad2(slotStartDt.getHours())}:${pad2(
          slotStartDt.getMinutes()
        )}`;
        const endStr = `${dKey}T${pad2(slotEndDt.getHours())}:${pad2(
          slotEndDt.getMinutes()
        )}`;

        const subtaskLabel = task.subtasks.length > 0 ? task.subtasks[task.nextSubIndex] : "";
        if (task.subtasks.length > 0) {
          task.nextSubIndex = (task.nextSubIndex + 1) % task.subtasks.length;
        }

        const titleBase = `${task.course ? task.course + " • " : ""}${task.title}`;
        const fullTitle = subtaskLabel ? `${titleBase} – ${subtaskLabel}` : titleBase;

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

  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

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
      notes: "מבנה העבודה:\n- מבוא\n- גוף\n- סיכום",
    },
  ]);

  const [weeklyObligations, setWeeklyObligations] = useState<WeeklyObligationRow[]>([
    {
      id: generateId("wo"),
      weekday: 0,
      startTime: "21:30",
      endTime: "22:30",
      label: "טיול עם הכלב",
    },
  ]);

  const [specificObligations, setSpecificObligations] = useState<SpecificObligationRow[]>([]);

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

  const [result, setResult] = useState<ScheduleResult | null>(null);
  const [icsContent, setIcsContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [scheduleApproved, setScheduleApproved] = useState<boolean>(false);
  const [hasDownloadedOnce, setHasDownloadedOnce] = useState<boolean>(false);

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
    setError(null);
    setScheduleApproved(false);

    const hasValid = assignments.some(
      (a) => a.title.trim() && a.deadline && a.estimatedHours > 0
    );
    if (!hasValid) {
      setResult(null);
      setIcsContent(null);
      setError("יש להזין לפחות מטלה אחת עם דדליין ושעות משוערות.");
      return;
    }
    const schedule = generateSchedule(
      assignments,
      weeklyObligations,
      specificObligations,
      dailyObligations,
      settings
    );
    setResult(schedule);
    if (!schedule.events.length) {
      setIcsContent(null);
      setError("לא נוצרו בלוקים. עדכן/י שעות עבודה, אילוצים או דדליינים.");
    } else {
      setIcsContent(buildIcs(schedule.events, settings.timezone));
    }
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
              <li>אלגוריתם חלוקה דינמי לפי מצב עומס, דדליין ותתי משימות.</li>
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
                  בחר/י אזור זמן, תאריך התחלה, חלון עבודה יומי, מצב עומס והגבלות עומס.
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
                      מצב רגוע מפזר עבודה על פחות בלוקים ביום, מצב מרתון מנצל את המקסימום
                      שהגדרת.
                    </small>
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
                      כל שורה מייצגת מטלה גדולה. אפשר לפרט תתי משימות בשדה ההערות, שיכנסו
                      ללו״ז.
                    </p>
                  </div>
                  <button type="button" className="secondary" onClick={addAssignment}>
                    <Plus size={14} />
                    הוספת מטלה
                  </button>
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
                                "אפשר לכתוב תתי משימות, כל שורה או תבליט כשלב נפרד.\nלדוגמה:\n- קריאת מאמרים\n- כתיבת שלד\n- ניסוח סופי"
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
                      הלו״ז מחלק את הזמן לפי מצב העומס, הדדליינים ותתי המשימות. כל בלוק מסומן
                      לפי תת משימה. אפשר לאשר ואחר כך להוריד קובץ ICS.
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

                {error && <div className="error-box">{error}</div>}

                {result && (
                  <>
                    <div className="summary-row">
                      <span>סה"כ אירועים: {result.events.length}</span>
                      <span>מספר מטלות: {assignments.length}</span>
                      {result.unscheduled.length > 0 && (
                        <span>מטלות שלא שובצו: {result.unscheduled.length}</span>
                      )}
                      {!scheduleApproved && result.events.length > 0 && (
                        <span>יש לאשר את הלו״ז לפני הורדה.</span>
                      )}
                    </div>

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
                    כדי לראות תוצאה, ודא/י שהזנת מטלות ואילוצים ולאחר מכן לחץ/י על הכפתור יצירת
                    לו״ז. לאחר מכן יש לאשר את הלו״ז ורק אז להוריד קובץ ICS.
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