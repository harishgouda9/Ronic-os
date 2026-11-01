---
name: mineru
description: "High-accuracy document parsing engine by OpenDataLab. Use when converting complex PDFs, DOCX, PPTX, EPUB, or document images into structured Markdown, LaTeX math formulas, tables, and JSON. Triggers include requests to 'parse PDF', 'extract PDF to markdown', 'convert paper to markdown', 'read complex document', 'extract math formulas from PDF', or 'ingest presentation/document slides into LLM context'. Do not use for simple plain text files or editing documents."
slash_command: /mineru
requires_tools: [run_command, read_file]
platforms: [windows, macos, linux]
license: Apache-2.0
---

# MinerU Document Extraction

High-accuracy document parsing engine developed by OpenDataLab. Transforms complex, multi-column, formula-heavy, and tabular documents (PDF, DOCX, PPTX, images) into clean, LLM-ready Markdown and JSON.

## Key Capabilities

- **Formula Extraction:** Detects inline and display mathematical formulas and converts them into LaTeX (`$math$` and `$$math$$`).
- **Table Preservation:** Preserves nested tables, cell merges, and financial balance sheets in clean Markdown or HTML table formats.
- **Reading Order Layout Analysis:** Correctly orders multi-column research papers, sidebars, and footnotes without interleaving columns.
- **Figure & Image Segmentation:** Extracts embedded diagrams, charts, and illustrations into separate image files linked from the generated Markdown.
- **Multi-Format Ingestion:** Supports PDF, DOC, DOCX, PPT, PPTX, EPUB, and image files (PNG, JPG, TIFF).

## Install Only When Missing

Before running extraction, check if `mineru` or `magic-pdf` is available on `PATH`:

```bash
mineru --version || magic-pdf --version
```

If missing, install via `uv` or `pip` in a dedicated environment:

```bash
# Recommended lightweight install (ONNX runtime + CPU inference)
uv pip install -U "mineru>=4.0,<5"

# Full installation with local PyTorch / CUDA acceleration (for GPU systems)
uv pip install -U "mineru[all]>=4.0,<5"
```

### Pre-download Models (First-Time Setup)

To avoid network timeouts during runtime inference:

```bash
mineru-kit models download --tier standard
```

Tiers:
- `flash`: Fast native text extraction for clean digital PDFs (minimal model overhead).
- `standard`: Balanced OCR + layout parsing with formula & table recognition.
- `advanced`: Full high-accuracy vision-language model (VLM) parsing for complex scanned documents.

## CLI Extraction Workflows

### 1. Extract a PDF or Document to Markdown

Run extraction on a single document:

```bash
# Standard v4+ CLI syntax
mineru run --input "/path/to/document.pdf" --output "/path/to/output_dir" --backend pipeline

# Compatibility syntax (magic-pdf)
magic-pdf -p "/path/to/document.pdf" -o "/path/to/output_dir" -m auto
```

### 2. Batch Ingestion of a Directory

```bash
mineru run --input "/path/to/documents_dir" --output "/path/to/extracted_markdown"
```

### 3. Extracting Office Presentations (PPTX) or Word Docs (DOCX)

```bash
mineru run --input "/path/to/slides.pptx" --output "/path/to/output_dir"
mineru run --input "/path/to/report.docx" --output "/path/to/output_dir"
```

## Output Structure

MinerU produces an output directory named after the source file:

```
output_dir/
└── document_name/
    ├── auto/
    │   ├── document_name.md         # Primary clean Markdown document with LaTeX math
    │   ├── content_list.json        # Structured JSON with bounding boxes and block tags
    │   ├── model_output.json        # Layout analysis coordinates
    │   └── images/                  # Extracted figures, charts, and diagrams
    │       ├── figure_1.jpg
    │       └── figure_2.png
```

## Agent Best Practices

1. **Read Extracted Output:** After running `mineru run`, locate the generated `<doc_name>.md` and read it with `read_file` to feed into chat, bot memory, or RAG indexing.
2. **Handle LaTeX Formulas:** MinerU outputs clean LaTeX math. In Ronic OS UI and chat, render inline math using `$formula$` and display math using `$$formula$$`.
3. **Table Inspection:** For complex financial tables or scientific matrices, inspect `content_list.json` if cell-by-cell coordinates or raw cell contents are needed.
4. **Preserve Relative Images:** When copying or citing extracted sections, keep the relative image links intact so Ronic OS can display figures inline.

