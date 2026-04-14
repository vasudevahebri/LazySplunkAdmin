# Splunk Enterprise Daily Ops Studio

GitHub-ready static web package for a Splunk Professional Services style deployment, operations, placement, and troubleshooting workspace.

## Included files

- `index.html` - main studio
- `help_user_guide.html` - user guide
- `engineer_sop.html` - field SOP
- `ps_cli_reference.html` - CLI reference
- `support.css` - shared styling for support pages
- `support.js` - shared support-page behavior
- `.nojekyll` - recommended for GitHub Pages static hosting

## Upload to GitHub

1. Create a new repository.
2. Upload all files from this folder to the repository root.
3. Commit the files.
4. Optional: enable GitHub Pages from the root branch.
5. Open `index.html` locally or use the GitHub Pages URL.

## Notes

- Keep all files in the same folder so the page links work.
- The support pages are linked from `index.html`.
- This package is static HTML, CSS, and JavaScript only.
- No build step is required.

## Disclaimer gate

- `disclaimer.html` is the required first-open acknowledgment page.
- `index.html` redirects to the disclaimer until acceptance is stored locally.

## Sample data

- The bundled sample files are for demo purposes and should be modified for your own requirements before use.
