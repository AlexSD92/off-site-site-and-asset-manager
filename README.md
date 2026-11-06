# Off-Site Site and Asset Manager

**YardMap** is an offline-friendly, mobile-responsive site-plan and asset-clearance tracker for off-site plant and machinery auctions.

Built in **HTML, CSS and vanilla JavaScript**. No third-party runtime dependencies, accounts, remote APIs or build step required.

## Features

- Create scaled site plans on an adjustable grid.
- Mark walls, doors, roller shutters, lot footprints, locks and location labels.
- Record lot identifiers, invoice references, dimensions, notes and statuses.
- Green off cleared lots and distinguish pending, on-hold, issue and reserved items.
- Keep lock/key references and access notes alongside the plan.
- Track clearance progress in a simple dashboard.
- Save site plans in the local browser using `localStorage`.
- Export/import site plans as JSON; export PNG plans and CSV lot lists.
- Use mouse controls on desktop and touch-friendly tools on mobile.

## Run locally — required for confidential admin data

Use a modern browser and keep **`index.html`**, **`styles.css`**, **`invoice-report.js`** and **`app.js`** together.

In PowerShell, from the checked-out project folder:

```powershell
py -m http.server 8000 --bind 127.0.0.1
```

Open **http://127.0.0.1:8000** in the same computer's browser. The `--bind 127.0.0.1` restriction is important: it prevents the built-in Python server from listening on your local network. You may also open `index.html` directly (file://), though local-server mode is more reliable.

**Do not use a GitHub Pages URL to import or view confidential admin data.** The admin import feature is deliberately disabled on all hosts except localhost/127.0.0.1 and file://.

## Daily admin Excel matching

1. **Export Site JSON** backs up the drawing and its lot identifiers, without including imported admin contact records.
2. Go to **Admin Data** → **Import daily Excel (.xlsx)**, and select the admin export on your computer.
3. The import uses the *actual column headings* in the supplied workbook, notably `AuctionEventID`, `LotNumber` and `dbo.RWX_Invoices::Id`. No columns are inferred from position alone.
4. Review the auction event ID and how many existing drawn lots match. Confirm the import to save the report in this browser for **this site only**.
5. Select any drawn lot to see invoice ID, purchaser/billing details, mobile, telephone, username, payment status and the other lots on the same invoice.
6. **Download admin JSON** saves a *confidential* JSON report containing all 16 original admin headings. **Import admin JSON** reloads it later. A newer Excel report replaces the prior report for that site without touching the layout.

Rows with blank invoice ID are not grouped by purchaser ID; ambiguous duplicate lot numbers are not automatically matched. Imported admin payment status does **not** automatically green off a lot.

The current browser implementation supports modern `.xlsx` (not old binary `.xls` or encrypted workbooks), parsing entirely on-device through the browser's built-in ZIP decompression and XML parser.

## Privacy and safety

**Never add real Excel files, invoice/customer exports or downloaded JSON reports to Git.** The repository is code-only. No admin spreadsheet contents are uploaded to GitHub by the import feature.

The import UI is disabled on GitHub Pages and other hosted domains. GitHub Pages sites may be public even when their repository is private; site visits also disclose connection metadata (including IP addresses) to the hosting provider.

A restrictive Content Security Policy blocks browser `fetch`, XHR, WebSockets and other outgoing network connections from YardMap. All app scripts and styles are local files; there are no remotely loaded fonts, analytics, trackers or CDNs.

**Browser localStorage is not encryption.** Use a trusted, access-controlled work computer/browser profile and encrypted drives/backups if handling real customer data. Data can be lost if browser storage is cleared, and anyone with access to the same browser profile may access it. Ask your organisation's data controller/IT team to approve this storage method before using live records.

## Data, privacy and backups

Project data is stored in **that browser, on that device**. It is not uploaded to GitHub or synchronized with other devices. Browser storage may be cleared; **export JSON backups regularly** and keep them somewhere safe. Import JSON to continue on another browser or device.

**Do not commit exported real client/site data** to the repository, even when private. Use generic or redacted sample records for testing.

## Repository

Repository name: `off-site-site-and-asset-manager`. Check visibility and disable GitHub Pages before using live client data; a private Git repository does not by itself make its Pages site private.

From an existing local clone, update the code with:

```powershell
git pull origin main
```

These commands require Git authentication on the machine used to push.
