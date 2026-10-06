# Precise Page Renamer for PlanSwift 11

An original, local PlanSwift page renaming tool. It reads the printed sheet number and optional sheet title from user-drawn title-block regions, previews every proposed name, and applies only checked rows through PlanSwift's COM interface. It does not include or run SwiftRename code.

## What it does

- Reads the current PlanSwift 11 job and previews its sheet images.
- Runs Tesseract OCR locally, with no plan upload or account.
- Lets you process only selected sheets, useful when different disciplines use different title blocks.
- Flags low confidence, uncertain sheet numbers, and duplicate proposed names. Suspicious rows start unchecked.
- Lets you edit and export the preview before changing PlanSwift.
- Checks the active job, page GUID, and original name again immediately before applying.
- Saves a local change journal and offers **Undo last run** when names have not changed since that run.

## Run on this PC

1. Extract the entire ZIP into a **permanent local folder** you can write to. Keep `node_modules`, `assets`, `bridge`, and `ui` alongside `server.js`.
2. Open the correct job in PlanSwift 11.
3. Double-click **Start Precise Page Renamer.cmd**. Node.js is required and is already installed on the computer where this was built.
4. In the browser page, pick a clear sheet. Click **Draw sheet number** and drag a tight box around the printed number. Optionally draw the title. Select the sheets using the same title-block layout.
5. Click **Read selected sheets**. Inspect each proposed name and check or uncheck rows. Correct OCR mistakes in the text boxes.
6. Click **Apply checked names to PlanSwift**. A journal is saved in `data`. Use **Undo last run** to restore the preceding names if the pages have not since been edited.

Run separate passes for sheets with shifted or differently arranged title blocks. The blue title box is optional if you want only `A1.1` style names.

## Add a PlanSwift button

PlanSwift supports **Shell Execute**, **Executable**, and **Script Code** plugins. In PlanSwift, go to **Plugins → Tools Manager → green +**, name it `Precise Page Renamer`, and select **Shell Execute** as the plugin type. Point its command/script field at the full path of `Start Precise Page Renamer.cmd`. Set **On Ribbon Bar** if you want a button on the ribbon; choose the Tools tab and a Page Naming group. Test the green Run button. If the field does not accept a `.cmd` directly on your build, use `C:\Windows\System32\cmd.exe` with `/c "C:\full\path\Start Precise Page Renamer.cmd"` as its parameter.

The ZIP also runs on its own before you add the ribbon button. Do not move the extracted folder after adding the PlanSwift button; its command stores that path.

## Testing and current limit

The local OCR engine passed an end-to-end test on a synthetic TIFF with a sheet number and title. The browser preview read the current 30-page PlanSwift job and served its TIFF image. A read-only scan on a real sheet exposed an `O`/`0` ambiguity; the tool now proposes `0` and flags the correction for review.

**The COM write/undo step has not been exercised against a live disposable PlanSwift job.** This PC's PlanSwift COM server reported no open job during development. The tool refuses to write when PlanSwift does not report an open job, and it never edits PlanSwift's job XML directly. Test a copied job before using Apply on an active estimate. If a call times out, check the Pages list before trying again; the journal marks the result as uncertain.

This build targets the installed PlanSwift 11 path `C:\Program Files (x86)\PlanSwift11`. The Node packages in the ZIP are built for Windows x64. The OCR model is from the open-source `tessdata_fast` English model, and package license notices are preserved in `node_modules`.

References: [PlanSwift developer overview](https://help.constructconnect.com/planswift-developer-documentation-234/planswift-developer-overview-scripting-and-customization-tools-1551), [PlanSwift plugin types](https://help.constructconnect.com/02-introduction-to-planswift-175/planswift-02-13-the-plugins-tab-overview-2658), [Tesseract OCR model](https://github.com/tesseract-ocr/tessdata_fast).
