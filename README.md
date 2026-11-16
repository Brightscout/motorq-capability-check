# Motorq Capability Check

Front-end logic for the Motorq Capability Check form on the Webflow site. Users upload or paste their VINs, enter their contact details, and the form sends everything to the Motorq API. Results arrive by email.

Everything runs in the browser. There is no intermediate server.

## Flow

1. **Step 1: VINs.** The user uploads a file (`.xlsx`, `.csv`, `.txt`) or pastes VINs. The script reads it, checks for allowed characters, extracts the VINs, removes duplicates and counts them. Nothing is sent yet; VINs stay in memory.
2. **More than 1,000 VINs:** the user goes to the "Talk to an Expert" form, which posts to the HubSpot Forms API.
3. **Step 2: contact details.** Full name, work email (personal email providers are blocked) and Cloudflare Turnstile.
4. **Submit:** a single POST to the Motorq API with `fullName`, `email`, `vins` (`VIN1,VIN2,VIN3`) and `turnstileToken`. The API is asynchronous: a 200/202 response shows the success screen. Motorq's backend creates the HubSpot lead and sends the results email.

## Files

| File | Purpose |
|---|---|
| `src/vin-parser.js` | Reads files or pasted text, validates characters, extracts and dedupes VINs (`window.MotorqVins`) |
| `src/email-check.js` | Work email validation and personal email blocking (`window.MotorqEmail`) |
| `src/form-controller.js` | Form steps, Back button, errors and submissions (`window.MotorqCapCheck`) |
| `dist/capability-check.js` | The three source files bundled into one script |
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
    submitCheck: function (payload) {
      return fetch(/* Motorq API endpoint */);  // return the Response
    },
    submitExpert: function (payload) {
      return fetch(/* HubSpot Forms API */);
    },
  });
</script>
```

Pin a tag (`@v1.0.0`) instead of a branch so jsDelivr serves a fixed version.

### Submitting

- `submitCheck` and `submitExpert` must return a promise. If it resolves with something that has a numeric `status` (like a `fetch` Response), only `successStatuses` count as success (default `[200, 202]`). Any other status, a rejection, a thrown error or no answer within `timeoutMs` (default 30 seconds) shows the error message and keeps the user on the same step with their data.
- After a failed submit, Turnstile is reset because its tokens can only be used once. It calls `resetTurnstile()` if given, otherwise `window.turnstile.reset()`.
- If `getTurnstileToken()` throws (the Turnstile script was blocked), the user sees the verification message instead of a dead button.
- While a submit is running, clicks on the submit buttons are ignored, so a double click sends one request even when the button is a link (`<a>`) or a `<div>`.
- `onError(err)` is called on every failure. HTTP failures carry `err.status` and `err.response`; timeouts carry `err.timeout`.

### Behavior

- If the user selects a file and also types in the text field, the file is used. If the file is removed or replaced while it is being read, that result is discarded.
- The Paste button does not read the clipboard. It moves focus to the text field so the user pastes there.
- When a step changes, focus moves to its first field. Error messages get `role="alert"` so screen readers announce them.
- Steps are hidden with the `hidden` attribute and `style.display = 'none'`, so a Webflow class that sets `display` on a step container doesn't show every step at once.
- Each step adds a browser history entry, so the browser's Back button (and Android's back gesture) returns to the previous step instead of leaving the page. Turn it off with `history: false`.
- Works inside a `<form>` (Webflow Form Block): buttons without a `type` become `type="button"`, Enter in a step 2 field submits that step, and the form itself never posts. A plain `<div>` is still the simplest container.

### Markup

The controller finds elements through `data-*` attributes. Custom selectors can be passed through the `selectors` option instead.

| Attribute | Element |
|---|---|
| `data-step="vins"`, `"details"`, `"expert"`, `"success"`, `"expert-success"` | Step containers (only one is visible at a time) |
| `data-field="file"` | File input |
| `data-file-name` / `data-action="clear-file"` | Selected file name / remove file |
| `data-field="vins-text"` | Textarea for pasted VINs |
| `data-action="paste"` | Paste button (mobile): focuses the textarea |
| `data-action="vins-submit"` | Step 1 button (disabled until there is content) |
| `data-error="vins"`, `"details"`, `"expert"` | Error message per step |
| `data-vin-count` | VIN count (can appear more than once) |
| `data-field="full-name"`, `"email"` | Step 2 fields |
| `data-action="details-submit"` | "Get My Results" button |
| `data-field="expert-name"`, `"expert-email"` | Talk to an Expert fields |
| `data-action="expert-submit"` | Talk to an Expert button |
| `data-action="back"` | Back button (any step) |

### Copy

Error messages live in `MotorqCapCheck.MESSAGES` and can be overridden through the `messages` option. Current values are placeholders until the client approves the final copy.

| Key | Current text |
|---|---|
| `invalid_input` | Invalid input. Use only letters, numbers, commas, spaces or line breaks. |
| `no_vins` | No VINs detected. |
| `unsupported_file` | Unsupported file. Upload a .xlsx, .csv or .txt file. |
| `file_read_error` | We couldn't read that file. Try again or paste your VINs. |
| `name_required` | Please enter your full name. |
| `email_required` | Please enter your work email. |
| `email_invalid` | Please enter a valid email address. |
| `email_personal` | Please use your work email. |
| `captcha` | Please complete the verification. |
| `server` | Something went wrong. Please try again in a few minutes. |

## Parsing rules

- **Clean-up first.** Full-width letters and digits become normal ones, invisible characters are removed (BOM, zero-width spaces, soft hyphens, direction marks from Outlook or Excel Online), odd spaces become normal spaces, and Cyrillic or Greek letters that look identical to Latin ones (`С`, `Α`…) become Latin.
- **Grid.** Text, CSV and the `.xlsx` sheet become rows and cells. Tabs separate columns when there are any (copy from Excel); otherwise commas do (CSV). Quoted cells are respected, so `"Model S, Long Range"` or a note with line breaks stays in one cell. Inside a cell, VINs can also be separated by spaces or commas.
- **Finding the VINs.** The parser looks for the first real VIN by its pattern (17 letters and numbers, no I, O or Q, at least one digit). If there are more VINs to its right than below it, the grid is read sideways. Then it keeps that VIN's column and any other column where most filled cells are only VINs. Other columns (make, model, notes, drivers) are ignored.
- **Inside the VIN columns:**
  - A cell with several words (a title, a footer like `Total vehicles: 2`, a row copied from a PDF like `12 Honda Accord <VIN>`) only gives its VINs, including mistyped ones of 11 to 20 characters.
  - Headers (`VIN`, `VIN #`, `Vehicle Identification Number`…) are skipped wherever they appear, also when repeated further down.
  - Above the first real VIN, a single value is kept only if it looks like a VIN (5 to 20 letters and numbers with at least one of each), so titles are dropped but `1G1AZ37` is kept.
  - Below it, any single value is sent: an invalid VIN is still a VIN, as requested by Motorq.
- **No real VIN anywhere:** only values that look like a VIN are sent. A sheet with no VINs (`Make, Model, Year`) or free text gives `no_vins`.
- Allowed characters in what is sent: letters and numbers. Anything else returns `invalid_input`. Ignored columns, titles and footers don't count.
- `.xlsx` files: the first **visible** sheet is read (hidden lookup or template sheets are skipped). Files are checked by their content: an old `.xls` renamed to `.xlsx` returns `unsupported_file`; a corrupted file, or one that was moved or deleted after being selected, returns `file_read_error`. Numbers in cells are read as plain digits.
- VINs are uppercased and deduplicated (configurable with `CONFIG.DEDUPE`). Invalid VINs inside the VIN columns are still sent, as requested by Motorq.
- More than 1,000 unique VINs → Talk to an Expert.

## Work email rules

- Personal email providers are blocked with a short list (`src/email-check.js`), including US ISPs and common disposable addresses. Subdomains count too (`nc.rr.com` is `rr.com`). Big providers are also blocked under their country domains (`yahoo.co.uk`, `hotmail.com.ar`…), but not under generic domains companies use (`.io`, `.ai`, `.tv`…).
- Domains with accented letters (`müller-logistik.de`) are accepted. Look-alike spellings are normalized first, so `ｇｍａｉｌ.com` counts as `gmail.com`. The part before the `@` only accepts the characters valid in an email address.

## Development

```bash
npm install
npm test        # unit tests (node:test)
npm run build   # generates dist/
```

Open `dist/test-form.html` in a browser to try the full flow.
