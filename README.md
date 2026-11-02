# Off-Site Site and Asset Manager

**YardMap** is an offline-friendly, mobile-responsive site-plan and asset-clearance tracker for off-site plant and machinery auctions.

Built in **HTML, CSS and vanilla JavaScript**. No dependencies, account, server or build step required.

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

## Run locally

Open **`index.html`** in a modern browser. The included `styles.css` and `app.js` must stay in the same directory. You can also use the separate single-file release, `YardMap_Standalone.html`, without the other files.

## Data, privacy and backups

Project data is stored in **that browser, on that device**. It is not uploaded to GitHub or synchronized with other devices. Browser storage may be cleared; **export JSON backups regularly** and keep them somewhere safe. Import JSON to continue on another browser or device.

**Do not commit exported real client/site data** to the repository, even when private. Use generic or redacted sample records for testing.

## Repository

Intended private GitHub repository name: `off-site-site-and-asset-manager`.

After creating an **empty private repository** under your own GitHub account (without initializing it with a README, license or .gitignore), run from this folder:

```bash
git remote add origin https://github.com/AlexSD92/off-site-site-and-asset-manager.git
git push -u origin main
```

These commands require Git authentication on the machine used to push.
