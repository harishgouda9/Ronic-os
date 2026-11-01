# Prebuilt skills

These playbooks ship with Ronic OS and install into the workspace on launch.

| Skill | Upstream |
| --- | --- |
| find-skills | https://github.com/vercel-labs/skills/tree/main/skills/find-skills |
| grill-me | https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me |
| agent-browser | https://github.com/vercel-labs/agent-browser/tree/main/skills/agent-browser |
| improve-codebase-architecture | https://github.com/mattpocock/skills/tree/main/skills/engineering/improve-codebase-architecture |
| computer-use | https://github.com/stablyai/orca/tree/main/skills/computer-use |
| code-review | https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review |
| vercel-react-best-practices | https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices |
| remotion-to-hyperframes | https://github.com/heygen-com/hyperframes/tree/main/skills/remotion-to-hyperframes |
| hyperframes-cli | https://github.com/heygen-com/hyperframes/tree/main/skills/hyperframes-cli |
| composio | https://github.com/ComposioHQ/composio (skill `composio`, installed with `npx skills add ComposioHQ/composio --skill composio -y`) |

Copied 2026-10-17. License texts are in `notices/`. `vercel-react-best-practices` declares MIT in its SKILL.md. That repository has no separate LICENSE file. The Composio skill is the upstream router from ComposioHQ/composio.

## NVIDIA Agent Skills (added 2026-10-28)

| Skill | Upstream |
| --- | --- |
| accelerated-computing-cudf | https://github.com/NVIDIA/skills/tree/main/skills/accelerated-computing-cudf |
| cudaq-guide | https://github.com/NVIDIA/skills/tree/main/skills/cudaq-guide |
| cuopt-numerical-optimization-api | https://github.com/NVIDIA/skills/tree/main/skills/cuopt-numerical-optimization-api |
| cuopt-numerical-optimization-formulation | https://github.com/NVIDIA/skills/tree/main/skills/cuopt-numerical-optimization-formulation |
| nemo-retriever | https://github.com/NVIDIA/skills/tree/main/skills/nemo-retriever |
| nemo-retriever-mcp | https://github.com/NVIDIA/skills/tree/main/skills/nemo-retriever-mcp |
| nemotron-policy-generator | https://github.com/NVIDIA/skills/tree/main/skills/nemotron-policy-generator |

NVIDIA skills are dual-licensed under Apache-2.0 and CC-BY-4.0. License texts are in `notices/`. Each skill includes a `skill-card.md` governance manifest documenting permissions, dependencies, and risks per the NVIDIA Agent Skills specification.

## OpenDataLab MinerU (added 2026-10-28)

| Skill | Upstream |
| --- | --- |
| mineru | https://github.com/opendatalab/MinerU |

MinerU is licensed under the MinerU Open Source License (Apache-2.0 base). Converts PDFs, DOCX, PPTX, and scanned documents into structured Markdown, LaTeX math, and tables for LLM agents. License notice is in `notices/mineru-LICENSE.txt`.
