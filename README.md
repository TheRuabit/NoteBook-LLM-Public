# PDF AI Annotator

A local-first PDF reader and annotator. Select text or draw regions on a PDF, ask an OpenAI-compatible model for help, and write highlights or notes back to an annotated copy.

## Features

- Add local PDF folders with the Windows folder picker.
- Select text or draw temporary rectangular regions across pages.
- Ask an OpenAI-compatible API about the selection.
- Add highlights and notes, then remove individual annotation nodes later.
- Keep personal papers, local configuration, and annotation state out of Git.

## Run locally

```powershell
npm install
npm start
```

Open `http://localhost:3000`, then configure the API endpoint, model, and key in **Settings**. The resulting `config.json` remains local and is ignored by Git.

## Test

```powershell
npm run selftest
```

The self-test creates its own temporary two-page PDF and mock API server. It does not require an API key or any personal papers.

## Local data

- `Papers/`, `config.json`, `.env*`, and `Paper-Index.md` are ignored.
- Annotation edit state is kept under `Papers/.annotation-state`.
- For folders added outside this project, generated `-annotated.pdf` files are written beside the source PDF; the edit state stays inside this project.

## License

No license has been selected yet.
