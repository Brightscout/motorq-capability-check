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
      // POST to the Motorq API (endpoint pending)
    },
    submitExpert: function (payload) {
      // POST to the HubSpot Forms API
    },
  });
</script>
```

Pin a tag (`@v1.0.0`) instead of a branch so jsDelivr serves a fixed version.

### Markup

The controller finds elements through `data-*` attributes. Custom selectors can be passed through the `selectors` option instead.

| Attribute | Element |
|---|---|
| `data-step="vins"`, `"details"`, `"expert"`, `"success"`, `"expert-success"` | Step containers (only one is visible at a time) |
| `data-field="file"` | File input |
| `data-file-name` / `data-action="clear-file"` | Selected file name / remove file |
| `data-field="vins-text"` | Textarea for pasted VINs |
| `data-action="paste"` | Paste from clipboard (mobile) |
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

- Allowed characters: letters, numbers, spaces, commas, line breaks and tabs. Anything else returns `invalid_input`.
- Empty rows, whitespace, the BOM and the header row are removed. A first row is treated as a header if it contains "VIN" and isn't a 17-character VIN.
- In `.xlsx` files, only the first sheet is read. If the header has a "VIN" column, only that column is used.
- VINs are uppercased and deduplicated (configurable with `CONFIG.DEDUPE`). Invalid VINs are still sent, as requested by Motorq.
- More than 1,000 unique VINs → Talk to an Expert.

## Development

```bash
npm install
npm test        # unit tests (node:test)
npm run build   # generates dist/
```

Open `dist/test-form.html` in a browser to try the full flow.
