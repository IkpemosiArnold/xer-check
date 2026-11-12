# What the AI got wrong, and how it was caught

A running log kept while building this on 12 Nov 2026. Each entry is something the AI-written code, or a first assumption, got wrong, how it was caught, and the fix. Nothing here is made up.

## 1. The weekday cross-check compared whole dates and called 40 good rows bad

- **What was wrong.** To sanity-check that float in hours divided by 8 is working days, the agent wrote a quick script: for each activity, count working days (Monday to Friday) between the row's early finish and late finish, and compare with total_float_hr_cnt / 8. It compared the date part only. It reported 40 mismatches: 4 of 83 in the Aspose file and 36 of 281 in the hb-intel file. That looked like either the wrong hours per day or a file whose float field could not be trusted.
- **How it was caught.** Reading the 40 rows. Every one had a clean float (0 h or 344 h) and a finish on a boundary. In the Aspose file, rows like A1200 had 0 h of float, early finish "2000-03-27 17:00" and late finish "2000-03-28 08:00": 08:00 the next morning is the same moment in working time as 17:00 the evening before, so float is 0, and the script said 1 day. In the hb-intel file, zero-length activities such as B02-022 had an early finish on Sunday "2026-06-07 17:00"; the script moved Sunday forward to Monday and got 42 days where the file says 43.
- **Fix.** `closeOfDay` in `checks.js`: a finish at 08:00 or earlier, or on a weekend, counts as the close of the working day before. After the fix, 83 of 83 and 281 of 281 agree: both samples agree under its weekday assumptions; that is a sanity check, not proof the calendars are right. A unit test pins the two edge cases.
- **Commit.** The wrong version was a scratch script and never committed. The fix is in a6e9a1a.

## 2. Assumed every activity names its calendar

- **What was wrong.** The first plan for hours per day was: read the activity's clndr_id, look up that calendar's day_hr_cnt.
- **How it was caught.** Reading the raw TASK rows of aspose-testXer.xer before writing that code. All 83 rows have clndr_id blank (proj_id is blank too). The lookup would have found nothing for every activity.
- **Fix.** Fall back in order: the activity's calendar, then the project's calendar (PROJECT.clndr_id, here "Standard", 8 h), then the calendar flagged as default, then 8 h. The page and the CLI say which one each file used. Commit a6e9a1a.

## 3. Assumed day_hr_cnt is always in the CALENDAR table

- **What was wrong.** The hours-per-day code expected a day_hr_cnt column.
- **How it was caught.** The hb-intel CALENDAR table has only clndr_id, clndr_name, proj_id, clndr_type, clndr_data and default_flag.
- **Fix.** Fall back to 8 h and say so on the page. The cross-check in entry 1 then showed 281 of 281 activities agree at 8 h under its weekday assumptions. That is a sanity check that the fallback fits this file, not proof the calendar is right. Commit a6e9a1a.

## 4. "Show all 32" showed up under a list that was already showing all 32

- **What was wrong.** Long lists show 12 rows and hide the rest with the `hidden` attribute. The CSS gave every list item `display: grid`, which beats the browser's default `[hidden] { display: none }`. So nothing was hidden, and the "Show all 32" button sat under the full list.
- **How it was caught.** The full-page screenshot at 390 px wide of the hb-intel file, with Missing links open.
- **Fix.** `.acts li[hidden] { display: none; }` in `style.css`. Commit 69ccd67.

## 5. Assumed a public .xer on GitHub is a P6 export

- **What was wrong.** The first search results looked like schedules, so the plan was to take the first two with a licence.
- **How it was caught.** Opening them. Several were small files built by hand or by a script for tests (one had an %E end-of-file marker in the middle, others were named "synthetic"). Even the Aspose file, which has a P6 8.3 header, carries calendar dates in a US format ("2/12/2004 3:19:00 PM") and a blank user name in the header line, which a P6 export would not write. It was most likely written by a converter.
- **Fix.** Chose files with a clear licence and real schedule content, and the README says what each file probably is rather than calling both P6 exports.
