# Motorq Capability Check

Front-end logic for the Motorq Capability Check form on the Webflow site. Users upload or paste their VINs, enter their contact details, and the form sends everything to the Motorq API. Results arrive by email.

Everything runs in the browser. There is no intermediate server.

## Flow

1. **Step 1: VINs.** Two tabs: **Upload File** (`.xlsx`, `.csv`, `.txt`) or **Paste VINs**. As soon as a file is selected or text is pasted, the script reads it, checks the characters, extracts and dedupes the VINs and shows "N VINs found". Errors only appear after pressing **Get My Results**. Nothing is sent yet; VINs stay in memory.
2. **Step 2: contact details.** First name, last name, work email (personal email providers are blocked) and Cloudflare Turnstile.
3. **Submit:** a single POST to the Motorq API. The API is asynchronous: a 200/202 response shows the success screen. Motorq's backend creates the HubSpot lead and sends the results email.
4. **Talk to an Expert** (posts to the HubSpot Forms API) opens in two ways: automatically with more than 1,000 VINs, or from the "talk with our team" link under the form on steps 1 and 2, with or without VINs. Coming from step 2, the first name, last name and email the user already typed are copied into the empty expert fields.
5. **Results email page** (`page: 'full-report'`). The button in the results email links to a separate page with the user's data in the URL (`?firstname=Jane&lastname=Doe&email=jane@acme.com`), added by Motorq's backend. That page shows only the expert form, prefilled from the URL, and posts to the full report HubSpot form. HubSpot dedupes contacts by email, so it updates the existing contact.

### Payloads

Motorq API (`submitCheck`):

```json
{ "fullName": "Jane Doe", "email": "jane@acme.com", "vins": "VIN1,VIN2,VIN3", "turnstileToken": "..." }
```

`fullName` is first and last name joined with one space, trimmed.

Talk to an Expert (what the controller builds; `submitExpert` receives it if given):

```json
{ "firstName": "Jane", "lastName": "Doe", "fleetSize": "50-250", "companyName": "Acme Logistics",
  "email": "jane@acme.com", "phone": "+1 (555) 123-4567", "source": "over-limit", "vinCount": 1500,
  "turnstileToken": "..." }
```

- `firstName`, `lastName`: only when the markup has the expert name fields (then they are required).
- `source`: `"over-limit"` (more than 1,000 VINs), `"link"` (the link under the form) or `"email"` (results email page).
- `vinCount`: only when the user has VINs loaded. From step 1 it is the count of the active tab; from step 2 or over the limit, the processed VINs.
- `turnstileToken`: only when `getExpertTurnstileToken` returns one. It never blocks the submit, because HubSpot can't verify it.
- `phone`: the country code and the number as typed.

### HubSpot

Without a custom `submitExpert`, the payload is posted to the [Forms API v3](https://developers.hubspot.com/docs/api/marketing/forms) (`src/hubspot.js`), portal `44687642`:

| `source` | HubSpot form | Form ID |
|---|---|---|
| `over-limit`, `link` | 1,000+ VINs form fill | `181fa58c-3817-4e24-9e0e-2429ac41fd64` |
| `email` | Full report (results email CTA) | `8409589a-e0c5-411e-9a55-14aad0619df1` |

- Fields sent: `firstname`, `lastname`, `email`, `company`, `fleet_size`, `phone`, plus the form's hidden `form_submission___pass_to_salesforce` value (the API doesn't apply hidden defaults). `source`, `vinCount` and `turnstileToken` are not sent: the forms have no fields for them.
- `fleet_size` values must match the form's options exactly: `1-50`, `50-250`, `250-500`, `500-1,000`, `More than 1,000` (the defaults in `src/contact-check.js`).
- `context` carries the page URL and title, and the `hubspotutk` cookie when the HubSpot tracking code runs on the site.
- HubSpot answers 200 on success and 400 with the list of errors (e.g. a missing required field), which shows the generic error.
- The under-1,000 VINs form (`007b32c4-…`) is not used here: Motorq's backend handles it after the Motorq API call.
- Other IDs can be passed with `hubspot: { portalId, forms: { expert: { formId, hidden }, fullReport: { … } } }`.

## Files

| File | Purpose |
|---|---|
| `src/vin-parser.js` | Reads files or pasted text, validates characters, extracts and dedupes VINs (`window.MotorqVins`) |
| `src/email-check.js` | Work email validation and personal email blocking (`window.MotorqEmail`) |
| `src/contact-check.js` | Name joining, phone validation, fleet size and country code options (`window.MotorqContact`) |
| `src/hubspot.js` | Talk to an Expert submissions to the HubSpot Forms API (`window.MotorqHubSpot`) |
| `src/form-controller.js` | Form steps, tabs, live VIN count, Back button, errors and submissions (`window.MotorqCapCheck`) |
| `dist/capability-check.js` | The source files bundled into one script |
| `dist/test-form.html` | Self-contained test form with the API, Turnstile and HubSpot mocked |

## Usage in Webflow

SheetJS has to load before the bundle (needed for `.xlsx` files):

```html
<script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Brightscout/<repo>@<tag>/dist/capability-check.js"></script>
<script>
  MotorqCapCheck.init({
    root: '#cap-check',
    getTurnstileToken: function () { return turnstile.getResponse(); },
    submitCheck: function (payload, opts) {
      return fetch(/* Motorq API endpoint */, { /* ... */ signal: opts.signal });  // return the Response
    },
    // Optional:
    // submitExpert: function (payload, opts) { ... },  // replaces the HubSpot submit
    // getExpertTurnstileToken: function () { ... },    // sent if present, never required
    // fleetSizes: ['1-50', '50-250', ...],              // must match the HubSpot options
    // phoneCountries: [{ value: '+1', label: 'US/CA +1' }, ...],
  });
</script>
```

Results email page (only the expert step and the expert success step in the markup):

```html
<script>
  MotorqCapCheck.init({
    root: '#full-report',
    page: 'full-report',
    // prefillParams: { firstName: 'firstname', lastName: 'lastname', email: 'email' },  // URL parameter names
  });
</script>
```

On that page Back does nothing (there is no previous step) and the browser history is not used.

Pin a tag (`@v1.0.0`) instead of a branch so jsDelivr serves a fixed version.

### Submitting

- `submitCheck` and `submitExpert` must return a promise. If it resolves with something that has a numeric `status` (like a `fetch` Response), only `successStatuses` count as success (default `[200, 202]`). Any other status, a rejection, a thrown error or no answer within `timeoutMs` (default 30 seconds) shows the error message and keeps the user on the same step with their data.
- Submit functions get `{ signal }` as a second argument. Pass it to `fetch(url, { ..., signal })`: when `timeoutMs` runs out the request is cancelled, so a late answer can't create a second lead if the user retries. `timeoutMs: 0` (or `Infinity`) turns the timeout off.
- After every submit, failed or not, Turnstile is reset because its tokens can only be used once. It calls `resetTurnstile()` if given, otherwise `window.turnstile.reset()`.
- If `getTurnstileToken()` throws (the Turnstile script was blocked), the user sees the verification message instead of a dead button.
- While a submit is running, clicks on the submit buttons are ignored, so a double click sends one request even when the button is a link (`<a>`) or a `<div>`.
- `onError(err)` is called on every failure. HTTP failures carry `err.status` and `err.response`; timeouts carry `err.timeout`.

### Behavior

- **Tabs.** Upload File and Paste VINs are tabs; only one is active. Switching keeps what was entered in the other tab, but only the active tab is ever sent. The tab marked `aria-selected="true"` starts active (otherwise the first one). Without tabs in the markup, a selected file wins over pasted text.
- **Live count.** "N VINs found" appears as soon as a file is selected, or 300 ms after the user stops typing. Invalid or empty input hides it; the error appears only after pressing the button. The live result is reused on submit, so nothing is parsed twice. If a file is removed or replaced while it is being read, that result is discarded.
- **Clear** empties the pasted text, hides the count and the error, like Remove does for the file.
- The Paste button does not read the clipboard. It switches to the Paste tab and moves focus to the text field so the user pastes there.
- **Talk to an Expert:** Back returns to the step the user came from. The fleet size and country code selects are filled from the options unless the markup already has real options (a single placeholder option is kept).
- When a step changes, focus moves to its first field. Error messages get `role="alert"` so screen readers announce them.
- Steps are hidden with the `hidden` attribute and `style.display = 'none'`, so a Webflow class that sets `display` on a step container doesn't show every step at once.
- Each step adds a browser history entry, so the browser's Back button (and Android's back gesture) returns to the previous step instead of leaving the page. Turn it off with `history: false`.
  - Entries the form didn't create (a `#section` link, Webflow's smooth scroll, other scripts) don't move the form, and their state is kept.
  - Back from a success screen starts over on step 1; Forward never shows a success screen again.
  - If the VINs changed after going Back, Forward stays on step 1 so stale VINs are never sent.
  - After a reload the form starts on step 1.
- Enter that confirms a Japanese, Chinese or Korean input candidate doesn't submit.
- Works inside a `<form>` (Webflow Form Block): buttons without a `type` become `type="button"`, Enter in a step 2 field submits that step, and the form itself never posts. A plain `<div>` is still the simplest container.

### Markup

The controller finds elements through `data-*` attributes. Custom selectors can be passed through the `selectors` option instead.

| Attribute | Element |
|---|---|
| `data-step="vins"`, `"details"`, `"expert"`, `"success"`, `"expert-success"` | Step containers (only one is visible at a time) |
| `data-tab="upload"`, `"paste"` | Tab buttons (get `aria-selected` and the `is-active` class, configurable with `activeClass`) |
| `data-panel="upload"`, `"paste"` | Tab panels |
| `data-field="file"` | File input |
| `data-file-name` / `data-action="clear-file"` | Selected file name / remove file |
| `data-field="vins-text"` / `data-action="clear-text"` | Textarea for pasted VINs / Clear link |
| `data-action="paste"` | Paste button (mobile): focuses the textarea |
| `data-vins-found` | "N VINs found" wrapper, hidden when there is no valid count |
| `data-vin-count` | VIN count (can appear more than once) |
| `data-action="vins-submit"` | "Get My Results" (disabled until the active tab has content) |
| `data-error="vins"`, `"details"`, `"expert"` | Error message per step |
| `data-field="first-name"`, `"last-name"`, `"email"` | Step 2 fields |
| `data-action="details-submit"` | "Email My Results" |
| `data-action="open-expert"` | "Talk with our team" link (steps 1 and 2; can appear more than once) |
| `data-field="expert-first-name"`, `"expert-last-name"` | Talk to an Expert first and last name (required by both HubSpot forms) |
| `data-field="fleet-size"` | Fleet Size `<select>` |
| `data-field="company-name"`, `"company-email"` | Talk to an Expert fields |
| `data-field="phone-country"` / `data-field="phone"` | Country code `<select>` / phone number |
| `data-action="expert-submit"` | Talk to an Expert "Submit" |
| `data-action="back"` | Back button (any step) |

### Copy

Error messages live in `MotorqCapCheck.MESSAGES` and can be overridden through the `messages` option. Current values are placeholders until the client approves the final copy.

| Key | Current text |
|---|---|
| `invalid_input` | Invalid input. Use only letters, numbers, commas, spaces or line breaks. |
| `no_vins` | No VINs detected. |
| `unsupported_file` | Unsupported file. Upload a .xlsx, .csv or .txt file. |
| `file_read_error` | We couldn't read that file. Try again or paste your VINs. |
| `first_name_required` | Please enter your first name. |
| `last_name_required` | Please enter your last name. |
| `email_required` | Please enter your work email. |
| `email_invalid` | Please enter a valid email address. |
| `email_personal` | Please use your work email. |
| `captcha` | Please complete the verification. |
| `fleet_size_required` | Please select your fleet size. |
| `company_name_required` | Please enter your company name. |
| `phone_country_required` | Please select a country code. |
| `phone_required` | Please enter your phone number. |
| `phone_invalid` | Please enter a valid phone number. |
| `server` | Something went wrong. Please try again in a few minutes. |

## Parsing rules

- **Clean-up first.** Full-width letters and digits become normal ones, invisible characters are removed (BOM, zero-width spaces, soft hyphens, direction marks from Outlook or Excel Online), odd spaces become normal spaces, and Cyrillic or Greek letters that look identical to Latin ones (`С`, `Α`…) become Latin.
- **Grid.** Text, CSV and the `.xlsx` sheet become rows and cells. Tabs separate columns when most lines have them (copy from Excel); otherwise commas do (CSV), so a stray tab doesn't change how a CSV is read. Quoted cells are respected, so `"Model S, Long Range"` or a note with line breaks stays in one cell. Inside a cell, VINs can also be separated by spaces or commas.
- **Finding the VINs.** The parser looks for the first real VIN by its pattern (17 letters and numbers, no I, O or Q, at least one digit). If there are more VINs to its right than below it, the grid is read sideways. Then it keeps that VIN's column and any other column where most filled cells are only VINs. Other columns (make, model, notes, drivers) are ignored.
- **Inside the VIN columns:**
  - A cell with several words (a title, a footer like `Total vehicles: 2`, a row copied from a PDF like `12 Honda Accord <VIN>`) only gives its VINs, including mistyped ones of 11 to 20 characters.
  - Headers (`VIN`, `VIN #`, `Vehicle Identification Number`…) are skipped wherever they appear, also when repeated further down.
  - Above the first real VIN, a single value is kept only if it looks like a VIN (5 to 20 letters and numbers with at least one of each), so titles are dropped but `1G1AZ37` is kept.
  - Below it, any single value is sent: an invalid VIN is still a VIN, as requested by Motorq.
- **VINs across one row** (read sideways): values left of the first VIN are only kept if they are 11+ characters, so unit numbers and plates (`TRK1001`, `ABC1234`) are not sent.
- **No real VIN anywhere** (all short or mistyped): with a VIN header, only that column is used; without one, only values that look like a VIN are sent. A sheet with no VINs (`Make, Model, Year`) or free text gives `no_vins`. Dates, models (`F-150`) and notes in other columns don't make the input invalid.
- Allowed characters in what is sent: letters and numbers. Anything else returns `invalid_input`. Ignored columns, titles and footers don't count.
- `.xlsx` files: the first **visible** sheet is read (hidden lookup or template sheets are skipped). Files are checked by their content: an old `.xls` renamed to `.xlsx` returns `unsupported_file`; a corrupted file, or one that was moved or deleted after being selected, returns `file_read_error`. Numbers in cells are read as plain digits.
- VINs are uppercased and deduplicated (configurable with `CONFIG.DEDUPE`). Invalid VINs inside the VIN columns are still sent, as requested by Motorq.
- More than 1,000 unique VINs → Talk to an Expert.

## Phone rules

Digits, spaces, dashes and parentheses only, with 6 to 15 digits. The country code comes from its own select.

## Work email rules

The same rules apply to the step 2 work email and the Talk to an Expert company email.

- Personal email providers are blocked with a short list (`src/email-check.js`), including US ISPs and common disposable addresses. Subdomains count too (`nc.rr.com` is `rr.com`). Big providers are also blocked under their country domains (`yahoo.co.uk`, `hotmail.com.ar`…), but not under generic domains companies use (`.io`, `.ai`, `.tv`…).
- Domains with accented letters (`müller-logistik.de`) are accepted. Look-alike spellings are normalized first, so `ｇｍａｉｌ.com` counts as `gmail.com`. The part before the `@` only accepts the characters valid in an email address.

## Development

```bash
npm install
npm test        # unit tests (node:test)
npm run build   # generates dist/
```

Open `dist/test-form.html` in a browser to try the full flow.

Browser tests (Playwright is not a dependency; point `PLAYWRIGHT_PATH` to an install):

```bash
PLAYWRIGHT_PATH=/path/to/node_modules/playwright node --test --test-concurrency=1 test/*.e2e.js
```
