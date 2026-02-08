import React, { useMemo, useState } from "react";
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

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function cloneDateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
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

function buildLocalDateTime(date: Date, minutesSinceMidnight: number): Date {
  const hh = Math.floor(minutesSinceMidnight / 60);
  const mm = minutesSinceMidnight % 60;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, 0, 0);
}

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
  const sorted = [...events].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  sorted.forEach((ev, index) => {
    const [dPart, tPart] = ev.start.split("T");
    const [yy, mm, dd] = dPart.split("-").map(Number);
    const [hh, mn] = tPart.split(":").map(Number);
    const startDt = new Date(yy || 1970, (mm || 1) - 1, dd || 1, hh || 0, mn || 0, 0);

    const [dPart2, tPart2] = ev.end.split("T");
    const [yy2, mm2, dd2] = dPart2.split("-").map(Number);
    const [hh2, mn2] = tPart2.split(":").map(Number);
    const endDt = new Date(yy2 || 1970, (mm2 || 1) - 1, dd2 || 1, hh2 || 0, mn2 || 0, 0);

    const summary = icsEscape(ev.title);
    const desc = icsEscape(ev.notes || "");
    const uid = `event-${index + 1}@mah-haloz`;

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;TZID=${tzid}:${formatIcsDateTime(startDt)}`);
    lines.push(`DTEND;TZID=${tzid}:${formatIcsDateTime(endDt)}`);
    lines.push(`SUMMARY:${summary}`);
    if (desc) lines.push(`DESCRIPTION:${desc}`);
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

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

const examKeywords = ["מבחן", "בוחן", "exam", "quiz", "midterm", "final"];

function proposeSubtasks(estimatedHours: number, title: string): string[] {
  const h = estimatedHours || 0;
  const lowerTitle = title.toLowerCase();
  const isExam = examKeywords.some((kw) => lowerTitle.includes(kw));

  if (isExam) {
    if (h <= 2) {
      return ["סקירת חומר", "פתרון שאלות לדוגמה", "חזרה מהירה לפני המבחן"];
    }
    return ["מיפוי נושאים", "פתרון תרגילים", "מבחני ניסיון", "חזרה ממוקדת לפני המבחן"];
  }

  if (h <= 1.5) return ["הבנת דרישות המשימה", "ביצוע וסגירה"];
  if (h <= 3) return ["קריאה ותכנון", "עבודה עיקרית", "בדיקה ושיפורים"];
  return ["תכנון וחלוקת חלקים", "עבודה ראשונית", "העמקה ושיפור", "עריכה והגשה"];
}

function parseSubtaskLabels(notes: string, estimatedHours: number, title: string): string[] {
  const cleaned = notes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l.length > 0);
  if (cleaned.length >= 2) return cleaned;
  return proposeSubtasks(estimatedHours, title);
}

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
      const deadlineDate = new Date(`${a.deadline}T23:59:00`);
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

  if (!tasks.length) return { events: [], unscheduled: [] };

  tasks.sort((a, b) => {
    if (a.deadlineDate.getTime() !== b.deadlineDate.getTime()) {
      return a.deadlineDate.getTime() - b.deadlineDate.getTime();
    }
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.remainingMinutes - a.remainingMinutes;
  });

  const startDateObj = cloneDateOnly(
    settings.startDate ? new Date(`${settings.startDate}T00:00:00`) : new Date()
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

  const addStudyMinutes = (dayKey: string, taskId: string, minutes: number) => {
    perDayStudyMinutes[dayKey] = (perDayStudyMinutes[dayKey] || 0) + minutes;
    const key = `${taskId}__${dayKey}`;
    perTaskPerDayMinutes[key] = (perTaskPerDayMinutes[key] || 0) + minutes;
  };

  const getStudyMinutes = (dayKey: string) => perDayStudyMinutes[dayKey] || 0;
  const getTaskDayMinutes = (taskId: string, dayKey: string) =>
    perTaskPerDayMinutes[`${taskId}__${dayKey}`] || 0;

  for (let offset = 0; offset < dayCount; offset += 1) {
    const currentDate = new Date(startDateObj);
    currentDate.setDate(startDateObj.getDate() + offset);
    const dKey = dateKey(currentDate);
    const weekday = currentDate.getDay();

    const weekBlocked = weeklyByDay[weekday] || [];
    const specificBlocked = specificByDate[dKey] || [];

    const addObligationEvent = (label: string, startMinutes: number, endMinutes: number) => {
      const sDt = buildLocalDateTime(currentDate, startMinutes);
      const eDt = buildLocalDateTime(currentDate, endMinutes);
      events.push({
        id: generateId("obl"),
        kind: "obligation",
        title: label || "אילוץ",
        start: `${dKey}T${pad2(sDt.getHours())}:${pad2(sDt.getMinutes())}`,
        end: `${dKey}T${pad2(eDt.getHours())}:${pad2(eDt.getMinutes())}`,
        notes: "אילוץ שחוסם זמן ביומן",
      });
    };

    weekBlocked.forEach((o) => {
      const s = parseTimeToMinutes(o.startTime);
      const e = parseTimeToMinutes(o.endTime);
      if (s !== null && e !== null && e > s) addObligationEvent(o.label, s, e);
    });
    specificBlocked.forEach((o) => {
      const s = parseTimeToMinutes(o.startTime);
      const e = parseTimeToMinutes(o.endTime);
      if (s !== null && e !== null && e > s) addObligationEvent(o.label, s, e);
    });
    dailyObligations.forEach((o) => {
      const s = parseTimeToMinutes(o.startTime);
      const e = parseTimeToMinutes(o.endTime);
      if (s !== null && e !== null && e > s) addObligationEvent(o.label, s, e);
    });

    if (!workingWeek.has(weekday)) continue;

    let windows: Array<[number, number]> = [];
    if (workEndMinutes > workStartMinutes) windows.push([workStartMinutes, workEndMinutes]);

    const blocked: Array<[number, number]> = [];
    weekBlocked.forEach((o) => {
      const s = parseTimeToMinutes(o.startTime);
      const e = parseTimeToMinutes(o.endTime);
      if (s !== null && e !== null && e > s) blocked.push([s, e]);
    });
    specificBlocked.forEach((o) => {
      const s = parseTimeToMinutes(o.startTime);
      const e = parseTimeToMinutes(o.endTime);
      if (s !== null && e !== null && e > s) blocked.push([s, e]);
    });
    dailyObligations.forEach((o) => {
      const s = parseTimeToMinutes(o.startTime);
      const e = parseTimeToMinutes(o.endTime);
      if (s !== null && e !== null && e > s) blocked.push([s, e]);
    });

    blocked.sort((a, b) => a[0] - b[0]);
    blocked.forEach((b) => {
      windows = subtractInterval(windows, b);
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

        const remainingWindow = winEnd - cursor;
        if (remainingWindow < 10) break;

        const baseBlock = Math.min(blockMinutes, remainingWindow);

        if (getStudyMinutes(dKey) >= effectiveDailyMinutes) break;

        const candidateIndices: number[] = [];
        for (let i = 0; i < tasks.length; i += 1) {
          const t = tasks[i];
          if (t.remainingMinutes <= 0) continue;
          if (getStudyMinutes(dKey) >= effectiveDailyMinutes) continue;
          if (getTaskDayMinutes(t.id, dKey) >= effectiveTaskMinutesPerDay) continue;

          const allocCandidate = Math.min(baseBlock, t.remainingMinutes);
          if (allocCandidate < 10) continue;

          if (getStudyMinutes(dKey) + allocCandidate > effectiveDailyMinutes) continue;
          if (getTaskDayMinutes(t.id, dKey) + allocCandidate > effectiveTaskMinutesPerDay)
            continue;

          const slotEndDtCandidate = buildLocalDateTime(currentDate, cursor + allocCandidate);
          const deadlineWithBuffer = new Date(
            tasks[i].deadlineDate.getTime() - bufferMinutes * 60 * 1000
          );
          if (slotEndDtCandidate.getTime() > deadlineWithBuffer.getTime()) continue;

          candidateIndices.push(i);
        }

        if (!candidateIndices.length) break;

        const scored = candidateIndices.map((idx) => {
          const t = tasks[idx];
          const msDiff = t.deadlineDate.getTime() - currentDate.getTime();
          const daysDiff = msDiff / (1000 * 60 * 60 * 24);
          const urgency = daysDiff <= 0 ? 10 : Math.min(10, 10 / daysDiff);
          const priorityScore = t.priority;
          const remainingBlocks = t.remainingMinutes / blockMinutes;
          const diversityPenalty = lastTaskIdForDay && t.id === lastTaskIdForDay ? 0.5 : 1;
          const scoreBase = urgency * 2 + priorityScore + remainingBlocks * 0.1;
          return { idx, score: scoreBase * diversityPenalty };
        });

        scored.sort((a, b) => b.score - a.score);

        let chosenIndex = scored[0].idx;
        if (
          lastTaskIdForDay !== null &&
          scored.length > 1 &&
          tasks[chosenIndex].id === lastTaskIdForDay
        ) {
          const alt = scored.find((s) => tasks[s.idx].id !== lastTaskIdForDay);
          if (alt) chosenIndex = alt.idx;
        }

        const task = tasks[chosenIndex];
        const alloc = Math.min(baseBlock, task.remainingMinutes);
        const slotStartDt = buildLocalDateTime(currentDate, cursor);
        const slotEndDt = buildLocalDateTime(currentDate, cursor + alloc);

        const startStr = `${dKey}T${pad2(slotStartDt.getHours())}:${pad2(
          slotStartDt.getMinutes()
        )}`;
        const endStr = `${dKey}T${pad2(slotEndDt.getHours())}:${pad2(slotEndDt.getMinutes())}`;

        const subtaskLabel = task.subtasks.length > 0 ? task.subtasks[task.nextSubIndex] : "";
        if (task.subtasks.length > 0) {
          task.nextSubIndex = (task.nextSubIndex + 1) % task.subtasks.length;
        }

        const baseTitle = task.course ? `${task.course} • ${task.title}` : task.title;
        const fullTitle = subtaskLabel ? `${baseTitle} – ${subtaskLabel}` : baseTitle;

        const notesParts = [
          `דדליין: ${task.deadline.replace(/-/g, "/")}`,
          `עדיפות: ${task.priority}`,
          `בלוק: ${alloc} דקות`,
        ];
        if (subtaskLabel) notesParts.push(`תת משימה: ${subtaskLabel}`);
        if (task.notes.trim()) notesParts.push(task.notes.trim());

        events.push({
          id: generateId("task"),
          kind: "task",
          title: fullTitle,
          start: startStr,
          end: endStr,
          course: task.course,
          notes: notesParts.join("\n"),
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
      title: t.title,
      remainingHours: Math.round((t.remainingMinutes / 60) * 10) / 10,
    }));

  return { events, unscheduled };
}

const todayIso = () => new Date().toISOString().slice(0, 10);

const defaultSettings: Settings = {
  timezone: "Asia/Jerusalem",
  startDate: todayIso(),
  workdayStart: "08:30",
  workdayEnd: "20:00",
  dailyMaxHours: 6,
  maxTaskHoursPerDay: 3,
  blockMinutes: 50,
  breakMinutes: 10,
  bufferHours: 6,
  workingWeekdays: [0, 1, 2, 3, 4],
  loadMode: "medium",
};

const emptyAssignment = (): AssignmentRow => ({
  id: generateId("asmt"),
  course: "",
  title: "",
  deadline: "",
  estimatedHours: 0,
  priority: 3,
  notes: "",
});

const emptyWeekly = (): WeeklyObligationRow => ({
  id: generateId("wobl"),
  weekday: 0,
  startTime: "09:00",
  endTime: "10:00",
  label: "שיעור/עבודה",
});

const emptySpecific = (): SpecificObligationRow => ({
  id: generateId("sobl"),
  date: todayIso(),
  startTime: "12:00",
  endTime: "13:00",
  label: "אילוץ בתאריך",
});

const emptyDaily = (): DailyObligationRow => ({
  id: generateId("dly"),
  startTime: "13:00",
  endTime: "14:00",
  label: "אילוץ יומי",
});

const App: React.FC = () => {
  const [showIntro, setShowIntro] = useState(true);
  const [activeStep, setActiveStep] = useState(1);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([emptyAssignment()]);
  const [weeklyObligations, setWeeklyObligations] = useState<WeeklyObligationRow[]>([]);
  const [specificObligations, setSpecificObligations] = useState<SpecificObligationRow[]>([]);
  const [dailyObligations, setDailyObligations] = useState<DailyObligationRow[]>([]);
  const [result, setResult] = useState<ScheduleResult | null>(null);
  const [icsContent, setIcsContent] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [scheduleApproved, setScheduleApproved] = useState(false);
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const [downloadedVersion, setDownloadedVersion] = useState(0);
  const [hasDownloadedOnce, setHasDownloadedOnce] = useState(false);

  const markDirty = () => {
    if (scheduleApproved) setScheduleApproved(false);
  };

  const validAssignments = useMemo(
    () => assignments.filter((a) => a.title.trim() && a.deadline && a.estimatedHours > 0),
    [assignments]
  );

  const handleGenerate = () => {
    if (!validAssignments.length) {
      setError("צריך לפחות מטלה אחת עם כותרת, תאריך הגשה ושעות משוערות.");
      setResult(null);
      setIcsContent("");
      setScheduleApproved(false);
      return;
    }
    const sched = generateSchedule(
      assignments,
      weeklyObligations,
      specificObligations,
      dailyObligations,
      settings
    );
    if (!sched.events.length) {
      setError("לא נוצרו אירועים. נסו להגדיל חלון עבודה, להפחית אילוצים או להאריך דדליין.");
      setResult(sched);
      setIcsContent("");
      setScheduleApproved(false);
      return;
    }
    setError("");
    setResult(sched);
    setIcsContent(buildIcs(sched.events, settings.timezone));
    setScheduleApproved(false);
    setScheduleVersion((v) => v + 1);
  };

  const handleDownloadIcs = () => {
    if (!icsContent || !scheduleApproved) return;
    const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "schedule.ics";
    a.click();
    URL.revokeObjectURL(url);
    setHasDownloadedOnce(true);
    setDownloadedVersion(scheduleVersion);
  };

  const onSettingsChange = (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }));
    markDirty();
  };

  const updateAssignment = (id: string, patch: Partial<AssignmentRow>) => {
    setAssignments((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    markDirty();
  };

  const removeAssignment = (id: string) => {
    setAssignments((rows) => rows.filter((r) => r.id !== id));
    markDirty();
  };

  const updateWeeklyObligation = (id: string, patch: Partial<WeeklyObligationRow>) => {
    setWeeklyObligations((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    markDirty();
  };

  const updateSpecificObligation = (id: string, patch: Partial<SpecificObligationRow>) => {
    setSpecificObligations((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    markDirty();
  };

  const updateDailyObligation = (id: string, patch: Partial<DailyObligationRow>) => {
    setDailyObligations((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    markDirty();
  };

  const handleWeekdayToggle = (value: number) => {
    setSettings((s) => {
      const exists = s.workingWeekdays.includes(value);
      const next = exists
        ? s.workingWeekdays.filter((d) => d !== value)
        : [...s.workingWeekdays, value].sort();
      return { ...s, workingWeekdays: next };
    });
    markDirty();
  };

  const downloadLabel = (() => {
    const needsUpdatedDownload = scheduleApproved && scheduleVersion > downloadedVersion;
    if (hasDownloadedOnce) {
      return needsUpdatedDownload ? "הורדת קובץ .ics מעודכן" : "הורדת קובץ .ics";
    }
    return "הורדת קובץ .ics";
  })();

  const loadModeLabel = (mode: LoadMode) => {
    switch (mode) {
      case "relaxed":
        return "רגוע (60%)";
      case "medium":
        return "בינוני (80%)";
      case "marathon":
        return "מרתון (100%)";
      default:
        return mode;
    }
  };

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-left">
          <div className="header-icon">
            <CalendarCheck2 size={20} />
          </div>
          <div>
            <h1 className="app-title">מה הלו"ז??</h1>
            <p className="app-subtitle">מתכנן לו"ז אקדמי חכם · RTL · ללא שרת</p>
          </div>
        </div>
        <div className="header-right">
          <Clock3 size={14} />
          <span>כל הזמנים ב־{settings.timezone || "Asia/Jerusalem"}</span>
        </div>
      </header>

      <main className="app-main">
        {showIntro && (
          <section className="card intro-card">
            <h2 className="card-title">ברוכים הבאים!</h2>
            <p className="card-desc">
              בואו נבנה יחד לו"ז חכם למטלות וקורסים, עם אילוצים, חלונות עבודה, וייצוא לקובץ
              .ics שניתן לייבא לכל יומן.
            </p>
            <ul className="intro-list">
              <li>4 שלבים: הגדרות, קורסים ומטלות, אילוצים, לוח זמנים וייצוא.</li>
              <li>מנוע תזמון מקומי (ללא רשת) שמאזן עומסים לפי דדליינים ועדיפויות.</li>
              <li>קובץ ICS כולל גם אילוצים כדי לראות חסימות ביומן.</li>
            </ul>
            <div className="intro-actions">
              <button className="primary" onClick={() => setShowIntro(false)}>
                בואו נתחיל
              </button>
            </div>
          </section>
        )}

        {!showIntro && (
          <>
            <div className="stepper" aria-label="wizard">
              {[
                { step: 1, label: "הגדרות" },
                { step: 2, label: "קורסים ומטלות" },
                { step: 3, label: "אילוצים" },
                { step: 4, label: "לו״ז וייצוא" },
              ].map((s) => (
                <button
                  key={s.step}
                  type="button"
                  className={`step-button ${activeStep === s.step ? "step-button-active" : ""}`}
                  onClick={() => setActiveStep(s.step)}
                >
                  <span className="step-number">{s.step}</span>
                  {s.label}
                </button>
              ))}
            </div>

            {activeStep === 1 && (
              <section className="card">
                <div className="card-header-row">
                  <div>
                    <h2 className="card-title">הגדרות</h2>
                    <p className="card-desc">
                      ימי עבודה, זמני התחלה/סיום, מגבלת עומס יומית, מרווחים ואזור זמן.
                    </p>
                  </div>
                </div>

                <div className="grid-two touch-grid">
                  <div className="field-group">
                    <label>אזור זמן (TZID)</label>
                    <input
                      value={settings.timezone}
                      onChange={(e) => onSettingsChange({ timezone: e.target.value })}
                      placeholder="Asia/Jerusalem"
                    />
                  </div>
                  <div className="field-group">
                    <label>תאריך התחלה</label>
                    <input
                      type="date"
                      value={settings.startDate}
                      onChange={(e) => onSettingsChange({ startDate: e.target.value })}
                    />
                  </div>
                  <div className="field-group">
                    <label>שעת התחלה</label>
                    <input
                      type="time"
                      value={settings.workdayStart}
                      onChange={(e) => onSettingsChange({ workdayStart: e.target.value })}
                    />
                  </div>
                  <div className="field-group">
                    <label>שעת סיום</label>
                    <input
                      type="time"
                      value={settings.workdayEnd}
                      onChange={(e) => onSettingsChange({ workdayEnd: e.target.value })}
                    />
                  </div>
                  <div className="field-group">
                    <label>מקסימום שעות ביום</label>
                    <input
                      type="number"
                      min={1}
                      step={0.5}
                      value={settings.dailyMaxHours}
                      onChange={(e) => onSettingsChange({ dailyMaxHours: Number(e.target.value) })}
                    />
                  </div>
                  <div className="field-group">
                    <label>מקסימום שעות לאותה מטלה ביום</label>
                    <input
                      type="number"
                      min={0.5}
                      step={0.5}
                      value={settings.maxTaskHoursPerDay}
                      onChange={(e) =>
                        onSettingsChange({ maxTaskHoursPerDay: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div className="field-group">
                    <label>אורך בלוק (דקות)</label>
                    <input
                      type="number"
                      min={15}
                      step={5}
                      value={settings.blockMinutes}
                      onChange={(e) => onSettingsChange({ blockMinutes: Number(e.target.value) })}
                    />
                  </div>
                  <div className="field-group">
                    <label>הפסקה בין בלוקים (דקות)</label>
                    <input
                      type="number"
                      min={0}
                      step={5}
                      value={settings.breakMinutes}
                      onChange={(e) => onSettingsChange({ breakMinutes: Number(e.target.value) })}
                    />
                  </div>
                  <div className="field-group">
                    <label>באפר לפני דדליין (שעות)</label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={settings.bufferHours}
                      onChange={(e) => onSettingsChange({ bufferHours: Number(e.target.value) })}
                    />
                  </div>
                  <div className="field-group">
                    <label>מצב עומס</label>
                    <div className="chip-row">
                      {(["relaxed", "medium", "marathon"] as LoadMode[]).map((mode) => (
                        <button
                          type="button"
                          key={mode}
                          className={`chip ${settings.loadMode === mode ? "chip-active" : ""}`}
                          onClick={() => onSettingsChange({ loadMode: mode })}
                        >
                          {loadModeLabel(mode)}
                        </button>
                      ))}
                    </div>
                    <small>קובע את אחוז הניצול היומי ומקסימום למטלה.</small>
                  </div>
                  <div className="field-group full-width">
                    <label>ימי עבודה</label>
                    <div className="weekday-toggle-row">
                      {weekdayLabels.map((w) => (
                        <button
                          type="button"
                          key={w.value}
                          className={`weekday-pill ${
                            settings.workingWeekdays.includes(w.value) ? "weekday-pill-active" : ""
                          }`}
                          onClick={() => handleWeekdayToggle(w.value)}
                        >
                          {w.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="card-footer">
                  <span className="muted small">קודם נגדיר זמני עבודה ואז נוסיף מטלות.</span>
                  <button className="primary" type="button" onClick={() => setActiveStep(2)}>
                    למטלות »
                  </button>
                </div>
              </section>
            )}

            {activeStep === 2 && (
              <section className="card">
                <div className="card-header-row">
                  <div>
                    <h2 className="card-title">קורסים ומטלות</h2>
                    <p className="card-desc">
                      הוסיפו מטלות עם דדליין, שעות משוערות, עדיפות ותתי משימות (מייצר חכם אם חסר).
                    </p>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => {
                      setAssignments((rows) => [...rows, emptyAssignment()]);
                      markDirty();
                    }}
                  >
                    <Plus size={14} />
                    הוספת מטלה
                  </button>
                </div>

                <div className="table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>קורס</th>
                        <th>כותרת</th>
                        <th>דדליין</th>
                        <th>שעות</th>
                        <th>עדיפות 1-5</th>
                        <th>תתי משימות / הערות</th>
                        <th className="icon-cell">מחיקה</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignments.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <input
                              value={a.course}
                              onChange={(e) => updateAssignment(a.id, { course: e.target.value })}
                              placeholder="שם הקורס"
                            />
                          </td>
                          <td>
                            <input
                              value={a.title}
                              onChange={(e) => updateAssignment(a.id, { title: e.target.value })}
                              placeholder="כותרת המטלה"
                            />
                          </td>
                          <td className="narrow">
                            <input
                              type="date"
                              value={a.deadline}
                              onChange={(e) => updateAssignment(a.id, { deadline: e.target.value })}
                            />
                          </td>
                          <td className="narrow">
                            <input
                              type="number"
                              min={0}
                              step={0.5}
                              value={a.estimatedHours}
                              onChange={(e) =>
                                updateAssignment(a.id, { estimatedHours: Number(e.target.value) })
                              }
                            />
                          </td>
                          <td className="narrow">
                            <input
                              type="number"
                              min={1}
                              max={5}
                              step={1}
                              value={a.priority}
                              onChange={(e) =>
                                updateAssignment(a.id, { priority: Number(e.target.value) })
                              }
                            />
                          </td>
                          <td>
                            <textarea
                              value={a.notes}
                              onChange={(e) => updateAssignment(a.id, { notes: e.target.value })}
                              placeholder="שורות = תתי משימות. אם ריק, נציע אוטומטית."
                            />
                          </td>
                          <td className="icon-cell">
                            <button
                              className="danger-icon"
                              type="button"
                              onClick={() => removeAssignment(a.id)}
                              aria-label="הסרת מטלה"
                            >
                              <Trash2 size={16} />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {assignments.length === 0 && (
                        <tr>
                          <td colSpan={7} className="center muted">
                            עדיין אין מטלות. הוסיפו לפחות אחת.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="card-footer">
                  <button className="secondary" type="button" onClick={() => setActiveStep(1)}>
                    « חזרה להגדרות
                  </button>
                  <button className="primary" type="button" onClick={() => setActiveStep(3)}>
                    לאילוצים »
                  </button>
                </div>
              </section>
            )}

            {activeStep === 3 && (
              <section className="card">
                <div className="card-header-row">
                  <div>
                    <h2 className="card-title">אילוצים</h2>
                    <p className="card-desc">
                      הוסיפו זמני חוסר זמינות שבועיים, בתאריכים ספציפיים או יומיים קבועים.
                    </p>
                  </div>
                </div>

                <div className="constraints-grid">
                  <div>
                    <div className="constraints-header">
                      <h3>אילוצים שבועיים</h3>
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => {
                          setWeeklyObligations((rows) => [...rows, emptyWeekly()]);
                          markDirty();
                        }}
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
                                updateWeeklyObligation(o.id, { weekday: Number(e.target.value) })
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
                              className="danger-icon"
                              type="button"
                              onClick={() =>
                                setWeeklyObligations((rows) => rows.filter((r) => r.id !== o.id))
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <input
                            value={o.label}
                            onChange={(e) => updateWeeklyObligation(o.id, { label: e.target.value })}
                            placeholder="שם האילוץ: עבודה, חוג, שיעור..."
                          />
                        </div>
                      ))}
                      {weeklyObligations.length === 0 && (
                        <div className="muted small">אין אילוצים שבועיים.</div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="constraints-header">
                      <h3>אילוצים בתאריכים</h3>
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => {
                          setSpecificObligations((rows) => [...rows, emptySpecific()]);
                          markDirty();
                        }}
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
                              onChange={(e) => updateSpecificObligation(o.id, { date: e.target.value })}
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
                              onChange={(e) => updateSpecificObligation(o.id, { endTime: e.target.value })}
                            />
                            <button
                              className="danger-icon"
                              type="button"
                              onClick={() =>
                                setSpecificObligations((rows) => rows.filter((r) => r.id !== o.id))
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <input
                            value={o.label}
                            onChange={(e) => updateSpecificObligation(o.id, { label: e.target.value })}
                            placeholder="למשל: מבחן, אירוע משפחתי, רופא..."
                          />
                        </div>
                      ))}
                      {specificObligations.length === 0 && (
                        <div className="muted small">אין אילוצים בתאריכים ספציפיים.</div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="constraints-header">
                      <h3>אילוצים יומיים</h3>
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => {
                          setDailyObligations((rows) => [...rows, emptyDaily()]);
                          markDirty();
                        }}
                      >
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
                              onChange={(e) => updateDailyObligation(o.id, { startTime: e.target.value })}
                            />
                            <span>עד</span>
                            <input
                              type="time"
                              value={o.endTime}
                              onChange={(e) => updateDailyObligation(o.id, { endTime: e.target.value })}
                            />
                            <button
                              className="danger-icon"
                              type="button"
                              onClick={() =>
                                setDailyObligations((rows) => rows.filter((r) => r.id !== o.id))
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <input
                            value={o.label}
                            onChange={(e) => updateDailyObligation(o.id, { label: e.target.value })}
                            placeholder="לדוגמה: ארוחת צהריים, תרגול קבוע..."
                          />
                        </div>
                      ))}
                      {dailyObligations.length === 0 && (
                        <div className="muted small">אין אילוצים יומיים.</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="card-footer">
                  <button className="secondary" type="button" onClick={() => setActiveStep(2)}>
                    « חזרה למטלות
                  </button>
                  <button className="primary" type="button" onClick={() => setActiveStep(4)}>
                    ללוח הזמנים »
                  </button>
                </div>
              </section>
            )}

            {activeStep === 4 && (
              <section className="card">
                <div className="card-header-row">
                  <div>
                    <h2 className="card-title">לו״ז וייצוא</h2>
                    <p className="card-desc">
                      יצירת לו״ז, בדיקת חוסרים, אישור והורדת קובץ ICS. המטלות והאילוצים כולם
                      נכללים בקובץ.
                    </p>
                  </div>
                  <div className="result-actions">
                    <button className="primary" type="button" onClick={handleGenerate}>
                      <Settings2 size={14} />
                      יצירת לו״ז
                    </button>
                    <button
                      className={
                        result && result.events.length > 0 && !scheduleApproved
                          ? "secondary"
                          : "secondary secondary-disabled"
                      }
                      type="button"
                      disabled={!result || result.events.length === 0 || scheduleApproved}
                      onClick={() => {
                        if (result && result.events.length > 0) setScheduleApproved(true);
                      }}
                    >
                      {scheduleApproved ? 'הלו"ז אושר' : 'אישור הלו"ז'}
                    </button>
                    <button
                      className={
                        icsContent && scheduleApproved ? "secondary" : "secondary secondary-disabled"
                      }
                      type="button"
                      disabled={!icsContent || !scheduleApproved}
                      onClick={handleDownloadIcs}
                    >
                      <Download size={14} />
                      {downloadLabel}
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
                        <span className="muted">יש לאשר לפני הורדת הקובץ.</span>
                      )}
                    </div>

                    {result.unscheduled.length > 0 && (
                      <div className="warning-box">
                        <p className="bold">מטלות שלא נכנסו במלואן:</p>
                        <ul>
                          {result.unscheduled.map((u) => (
                            <li key={u.title}>
                              {u.title} ({u.remainingHours} שעות שנותרו)
                            </li>
                          ))}
                        </ul>
                        <small>
                          אפשר להגדיל את מגבלת השעות, לאפשר עוד ימי עבודה או להקטין באפר/הפסקות.
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
                            const [dPartEnd, tEnd] = ev.end.split("T");
                            const dateLabel = dPart.split("-").reverse().join("/");
                            const dateEnd =
                              dPartEnd && dPartEnd !== dPart
                                ? ` → ${dPartEnd.split("-").reverse().join("/")}`
                                : "";
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
                                  {dateEnd}
                                </td>
                                <td>{tPart}</td>
                                <td>{tEnd}</td>
                              </tr>
                            );
                          })}
                          {result.events.length === 0 && (
                            <tr>
                              <td colSpan={5} className="center muted">
                                טרם נוצרו אירועים. לחצו על "יצירת לו״ז".
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
                    כדי לראות תוצאה, ודאו שהזנתם מטלות ואילוצים ולחצו על "יצירת לו״ז".
                  </div>
                )}

                <div className="card-footer">
                  <button className="secondary" type="button" onClick={() => setActiveStep(1)}>
                    « חזרה לעדכון הגדרות
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </main>

      <footer className="app-footer">
        מה הלו"ז?? · מתכנן לו"ז אקדמי חכם · ייצוא לקובץ ICS · מתאים ל־Google / Outlook / Apple
      </footer>
    </div>
  );
};

export default App;
