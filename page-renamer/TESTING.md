# Testing on the PlanSwift PC

Everything that can run without Windows and PlanSwift has been tested (see "Already tested" at the end). The steps below cover what only the PlanSwift PC can confirm. Do them in order: part A never changes PlanSwift; part B renames pages in a **throwaway test job**.

Record anything that does not match "Expected" and send the copied connection report (A3) with it.

## A. Read-only checks

**A1. Bridge scripts under this PC's Windows PowerShell** (no PlanSwift involved)

Open a Command Prompt in the extracted `page-renamer` folder and run:

```
node --test test\bridge.test.js
```

Expected: `# pass 13`, `# fail 0`. This runs the real bridge scripts in 32-bit Windows PowerShell 5.1 against a simulated PlanSwift, including UTF-8 names and every rollback path.

**A2. Job list and previews**

1. Open a real job in PlanSwift. Start the tool with `Start Precise Page Renamer.cmd`.
2. Expected: the header shows the job name and the same page count as PlanSwift's Pages list; page names match PlanSwift; clicking a page shows its sheet.

**A3. PlanSwift connection check**

Click **Check PlanSwift connection**, then **Copy report** and save the text.

Expected, every line ✓:

| Line | Expected detail |
| --- | --- |
| Job folder | job name, page count, all pages "with images" |
| Live page names | Names read from PlanSwift |
| OCR engine | Tesseract loaded |
| PowerShell | 5.1… (32-bit) |
| Connect | Attached through the running object table or class factory; 1 PlanSwift process(es) |
| Edition | your PlanSwift edition |
| Open job | job name and its Pages path |
| Match job folder | N of N pages matched by ID and name |
| Page properties | a number of properties; open "Properties of the first page" and check the scale property is listed |
| PlanSwift response | a few ms per request (over 100 ms makes renaming slow) |
| Takeoff check | number of takeoff items read and the seconds it took |

Also confirm in Task Manager that only one PlanSwift is running afterwards.

If **Connect** reports that Windows started a second PlanSwift: PlanSwift and the tool run at different permission levels. Start the tool from a PlanSwift ribbon button (README, "Add a PlanSwift button"), or make sure neither is set to "Run as administrator".

**A4. Recognition on real sheets**

1. Select all pages, keep **Find automatically**, click **Read selected sheets**.
2. Record: number of sheets, how many proposed names were right without edits, how many were flagged, and any wrong name that was *not* flagged (most important).
3. Try **Find on this sheet** on a typical sheet, switch to **Use boxes**, read the same sheets again and compare speed and accuracy.
4. Export the CSV and keep it with your notes.

Nothing is renamed in part A.

## B. Rename tests on a throwaway job

Create a small test job in PlanSwift: import a 3–5 page plan set, set the scale on two pages, and draw a few takeoff items on two pages (an area, a linear item and a count). Write down each page name, each page's scale and the takeoff quantities shown in PlanSwift.

**B1. Rename**

1. Read the sheets, check two or three rows, click **Rename checked pages in PlanSwift**.
2. Expected: while it runs, the status shows each step ("PlanSwift: renaming pages (3 of 30)…"); then "Renamed N page(s)". History lists how long each step took. In PlanSwift's Pages list the new names appear (note whether they appear immediately or only after clicking another page / reopening the job).
3. Expected: each renamed page still opens with its drawing, the same scale, and the same takeoff shown on it; takeoff totals unchanged.
4. Note what PlanSwift's own Undo (Ctrl+Z) does right after the rename (whether it reverts the names as one step). Redo it if it reverted.

**B2. Persistence**

Close the job in PlanSwift and open it again (or restart PlanSwift). Expected: the new names are kept. In the tool click **Reload job**, then **Check PlanSwift connection**: "Match job folder" is still N of N.

**B3. Undo a run**

In **History and restore**, click **Undo this run…** on the run from B1. Expected: the dialog lists the pages and their earlier names; after confirming, PlanSwift shows the earlier names and scales/takeoff are unchanged.

**B4. Restore original names**

Rename a few pages again, then rename one of them by hand in PlanSwift. Click **Restore original names…**. Expected: the dialog restores the other pages and lists the hand-renamed page as "Renamed outside this tool"; after confirming, those pages have their original names.

**B5. Refusals (nothing should change)**

- Read the sheets, then rename one of those pages by hand in PlanSwift, then try to rename it in the tool. Expected: an error saying the page was renamed since it was read; no changes.
- Open a different job in PlanSwift between reading and renaming. Expected: an error that a different job is open; no changes.
- Type a name that another page already has. Expected: the row turns red and the rename button is disabled.

**B6. Larger set**

On a copy of a real job (or a real job once B1–B5 pass), rename 20+ pages in one run. Note the time taken and confirm the checks in B1 step 3.

## Already tested (without Windows/PlanSwift)

- Naming rules, OCR look-alike corrections, name validation, rename ordering and restore plans (unit tests).
- Sheet number and title detection on synthetic sheets in three title-block layouts, at 100 and 200 dpi, blurred, skewed, 1-bit, numbers beside border lines, vertical text.
- The real bridge scripts (`manifest.ps1`, `apply.ps1`, `probe.ps1`) under PowerShell 7 on Linux against a mock of PlanSwift's COM members: renaming with read-back, UTF-8 names, refusal when a page changed, rollback when PlanSwift errors part-way, stores a different name, changes a page property, or changes takeoff quantities.
- The HTTP API end to end (read, apply, rollback, undo, restore all, diagnostics, token and host checks) and the browser UI in Chromium (auto and box modes, zoom, editing, duplicate/invalid blocking, apply, restore, CSV export/import).

Not testable here: PlanSwift's real COM server (attaching to the open instance, `GetItemByGUID`, setting `Name`, `NewChangeGroup`/`PostChanges` behaviour, whether PlanSwift writes the new names to the job folder), Windows PowerShell 5.1 itself (A1 covers it), real scanned plan sets, and the PlanSwift ribbon button.
