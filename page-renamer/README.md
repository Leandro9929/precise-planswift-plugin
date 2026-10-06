# Precise Page Renamer for PlanSwift

A local tool that reads the printed sheet number and sheet title off each PlanSwift page, shows the proposed page names for review and correction, renames the checked pages through PlanSwift's own COM interface, and can put the original names back. OCR runs on the PC; nothing is uploaded and no account is needed. It does not include or run SwiftRename code.

## What it does

- Lists the pages of the job open in PlanSwift, with a preview of each sheet.
- **Find automatically**: locates the sheet number and title in the title block on every sheet (right-hand strip, bottom strip or corner box, with or without "SHEET NUMBER" / "SHEET TITLE" labels, including vertical title blocks).
- **Use boxes**: draw a box around the number and the title once (or let "Find on this sheet" draw them) and read the same position on every selected sheet. If a box misses on a sheet, that sheet can be searched automatically.
- Reads numbers drawn inside revision clouds, boxes or grey bands and next to delta tags (the number's own glyphs are isolated before OCR); never takes a feet-inch dimension (`9'-9"`) as a sheet number.
- Fixes common OCR look-alikes (`AO.2` → `A0.2`, `A-1O1` → `A-101`, border lines read as `|`/`1`) and reports every correction.
- In box mode, if a box misses on a sheet, only the area around the box is searched, so drawing text is never used.
- Titles are taken from the title block's own column (the text directly above the number, or under a "SHEET TITLE" label); issue stamps such as "CHECK SET" or "PERMIT RE-SUBMISSION" and garbled low-confidence readings are ignored.
- Review table: edit the sheet number, title or full name; shows the image crop each value was read from, OCR confidence, warnings, duplicates and names PlanSwift or Windows cannot store. Rows with warnings start unchecked.
- Name format: `A1.1 - FLOOR PLAN`, `A1.1 FLOOR PLAN`, number only or title only; titles as printed, Title Case or UPPERCASE.
- CSV export/import for large sets (edit names in Excel, import back by page ID).
- Renames only checked pages, in a single PlanSwift change group.
- **History and restore**: every run is journaled. Undo any run, or restore every page this tool renamed to its original name. Pages renamed by hand afterwards are left alone and listed.

## How page data is protected

Renaming sets only the page item's `Name` through PlanSwift's COM interface; job files are never edited. Before and after each run the tool:

1. Re-reads the job and refuses to write if a different job is open or any page changed since it was read.
2. Finds each page by its **GUID** under the open job's `\Job\Pages` and checks its current name.
3. Connects to the PlanSwift that is already open. It never starts PlanSwift, and if Windows starts a second copy (PlanSwift and the tool running at different permission levels) it closes that copy and stops without changing anything.
4. After each rename, reads the name and GUID back from PlanSwift.
5. After the batch, compares the other properties (scale and so on) of the first renamed pages and the quantities of a sample of takeoff items (up to 400 items or 15 seconds) with the values from before. Every page is renamed by the same call, so a sample shows whether renaming touches anything else; the checks are kept short because each value is a separate request to PlanSwift and quantities can trigger recalculation.
6. If any check fails, or PlanSwift raises an error part-way, it sets the already-renamed pages back to their previous names and reports which pages, if any, could not be set back.

Page GUIDs, scales, measurements and takeoff therefore stay with each page; the checks in steps 4 and 5 confirm it on every run.

## Install and run

1. Right-click the ZIP → **Extract All…** into a permanent local folder you can write to, for example `C:\Tools\Precise Page Renamer`. Do not run the tool from inside the ZIP (Windows then copies out only the clicked file), and prefer a folder that iCloud Drive or OneDrive does not sync. Keep `node_modules`, `assets`, `bridge`, `lib` and `ui` next to `server.js`.
2. Node.js 20.9 or newer must be installed (`node --version`).
3. Open the job in PlanSwift.
4. Double-click **Start Precise Page Renamer.cmd**. The browser opens the tool; keep the black window open while you use it.
5. The first time on a PC, click **Check PlanSwift connection** and confirm every line is ✓ (see [TESTING.md](TESTING.md)).

If the folder is not writable, the journal is kept in `%LOCALAPPDATA%\Precise Page Renamer`. If PlanSwift is not installed in `C:\Program Files (x86)\PlanSwift11`, set its folder under **Settings**.

## Use

1. Select the sheets (all pages with an image are selected).
2. Choose **Find automatically**, or click **Find on this sheet** / draw the boxes and choose **Use boxes** for a set with one title block layout.
3. Click **Read selected sheets**. About 1–3 seconds per sheet.
4. Review. Fix anything in red; checked rows without problems show **Ready**.
5. Click **Rename checked pages in PlanSwift** and confirm.
6. To go back: **History and restore** → **Undo this run…** or **Restore original names…**. Each shows what will change before it runs.

## Add a PlanSwift button (optional)

PlanSwift's Plugins tab supports Shell Execute, Executable and Script Code plugins ([ConstructConnect: The Plugins tab](https://help.constructconnect.com/02-introduction-to-planswift-175/planswift-02-13-the-plugins-tab-overview-2658)). In PlanSwift, go to **Plugins → Tools Manager → green +**, name it `Precise Page Renamer`, choose **Shell Execute** and point it at the full path of `Start Precise Page Renamer.cmd`. Set **On Ribbon Bar** to get a button. If the field does not accept a `.cmd`, use `C:\Windows\System32\cmd.exe` with `/c "C:\full\path\Start Precise Page Renamer.cmd"`. Starting the tool from PlanSwift also guarantees both run at the same permission level. Do not move the folder afterwards; the button stores the path.

## Limits

- Page images must be raster files in the page folder (TIFF, PNG, JPEG or BMP). A page stored only as PDF is listed with "Page image format not supported".
- OCR is English (`tessdata_fast`). Hand-drawn or very faint title blocks need box mode or manual entry.
- Swapping two page names in one run is refused; rename one to a temporary name first.

## Troubleshooting

| Message | What to do |
| --- | --- |
| "Open a job in PlanSwift first" / "PlanSwift reports no open job" | Open the job in PlanSwift, then **Reload job**. |
| "PlanSwift data not found" | Set the PlanSwift program folder (the one containing `Data`) under **Settings**. |
| "Windows started a second PlanSwift…" | PlanSwift and the tool run at different permission levels. Start the tool from the PlanSwift ribbon button, or run neither "as administrator". Nothing was changed. |
| "PlanSwift is not running (no process named PlanSwift*)" | PlanSwift is closed, or its program has a different name. Check the name in Task Manager → Details and start the tool with `set PRECISE_PLANSWIFT_PROCESS=<name without .exe>` before `node server.js`. |
| "Page names were read from the job folder…" | PlanSwift did not answer the live name check; renaming still verifies every page in PlanSwift first. Run **Check PlanSwift connection**. |
| "…was renamed … since it was read" | Read the sheets again; someone renamed the page in the meantime. |
| "PlanSwift did not answer within … It stopped while …" | PlanSwift was busy or waiting on something (an open dialog, cloud sync). Nothing after that step ran. Check PlanSwift for a dialog, then run **Check PlanSwift connection** (it reports how fast PlanSwift answers) and try again; History shows how long each step took. If it stopped while reading takeoff quantities, turn that check off under **Settings**. |
| A run shows **partial** or **uncertain** | Open the run in History: each page shows its last confirmed name. Check those pages in PlanSwift; **Undo this run** restores the pages that still carry the run's names. |

## Files

| Path | Purpose |
| --- | --- |
| `server.js` | Local web server (127.0.0.1 only, random session token) |
| `lib/` | OCR (`ocr.js`), title-block detection (`detect.js`), naming rules (`naming.js`), scan jobs, rename ordering and restore plans, journal |
| `bridge/` | PowerShell scripts: `manifest.ps1` reads the open job's page list from PlanSwift's data folder; `apply.ps1` renames through COM; `probe.ps1` is the read-only connection check |
| `ui/` | Browser interface |
| `assets/eng.traineddata` | Tesseract English model from [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) |
| `data/` | Created on first run: `jobs/<job>/runs/*.json` journal, `originals.json`, `settings.json` |

## PlanSwift integration reference

The COM calls were checked against the PlanSwift9 type library in PlanSwift's official SDK examples ([github.com/PlanSwift/sdk-examples-2010](https://github.com/PlanSwift/sdk-examples-2010), `Interop.PlanSwift9.dll`) and the usage in those examples (`ps.GetItem(ps.Root.FullPath + '\Job\Takeoff')`, `ChildCount`/`ChildItem`, `GUID()`):

- ProgID `PlanSwift9.PlanSwift` (CLSID `{B521BEFE-947B-4FDD-8EA5-6478E4CB7D1D}`), interface `IPlanSwift`: `Root()`, `GetItem(FullPath)`, `NewChangeGroup(GroupName)`, `PostChanges()`, `Edition()`.
- `IItem`: `Name` (read/write), `GUID()`, `FullPath()`, `ChildCount()`, `ChildItem[Index]`, `GetItemByGUID(aGUID)`, `PropertyCount()`, `PropertyItem[Index]`, `GetPropertyResultAsString(Name, Default)`; `IPropertyObject.Name`, `ResultAsString()`.
- The library has no `IsJobOpen`; the open job is detected by resolving `Root.FullPath + '\Job\Pages'`.

See also the [PlanSwift developer overview](https://help.constructconnect.com/planswift-developer-documentation-234/planswift-developer-overview-scripting-and-customization-tools-1551).

## Development

```
npm install
npm test               # all tests; bridge/API tests need PowerShell (Windows PowerShell or pwsh)
npm run test:bridge    # bridge scripts only, against a mock PlanSwift COM object
npm run release        # dist/Precise_Page_Renamer_v<version>.zip with Windows x64 packages
```

Tests render synthetic plan sheets for OCR, and run the real bridge scripts against `test/fixtures/mock-planswift.ps1`, which imitates PlanSwift's COM members and writes renames into a fixture job folder.
