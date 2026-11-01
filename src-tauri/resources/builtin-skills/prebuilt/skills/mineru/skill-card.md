## Description: <br>
High-accuracy document parsing engine developed by OpenDataLab. Use when converting complex PDFs, DOCX, PPTX, EPUB, or document images into structured Markdown, LaTeX math formulas, tables, and JSON. Triggers include requests to parse PDFs, extract academic papers, extract math formulas, or ingest document slides into LLM context. <br>

This skill is ready for commercial/non-commercial use under the MinerU Open Source License (Apache-2.0 base). <br>

## Owner
OpenDataLab <br>

### License/Terms of Use: <br>
Apache 2.0 (MinerU Open Source License) <br>

## Use Case: <br>
AI agents and developers use this skill to parse multi-column scientific papers, technical reports, presentation decks, and scanned documents with high layout fidelity, extracting clean Markdown with embedded LaTeX math expressions and structured tables. <br>

### Deployment Geography for Use: <br>
Global <br>

## Requirements / Dependencies: <br>
**Requires API Key or External Credential:** No <br>
**CLI Dependencies:** `mineru` or `magic-pdf` (Python 3.10-3.14, installed via uv or pip) <br>

## Known Risks and Mitigations: <br>
Risk: Large documents or deep VLM inference can require significant memory or GPU VRAM. <br>
Mitigation: Use `--tier flash` for standard digital PDFs or execute batch parsing in subagent background tasks. <br>

## Reference(s): <br>
- [OpenDataLab MinerU GitHub Repository](https://github.com/opendatalab/MinerU) <br>
- [MinerU Documentation](https://opendatalab.github.io/MinerU/) <br>

## Skill Output: <br>
**Output Type(s):** [Shell commands, Markdown, JSON, Extracted Images] <br>
**Output Format:** [Markdown with LaTeX math and table structures] <br>

