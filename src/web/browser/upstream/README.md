# DeepSeek Harness client components

These styles and primitives come from DeepSeek Harness commit `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`. The MIT license is included in this directory and in the distributed workbench. [Upstream client source](https://github.com/deepseek-ai/deepseek-harness/tree/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/client)

| Upstream package | Files used by Everpeace |
| --- | --- |
| `ui-theme` | Base type and spacing, design palette, corners, elevation, focus and scrollbar styles |
| `ui-layout` and `ui-sidebar` | `AppFrame.module.css` and `SidebarRoot.module.css` |
| `ui-conversation` | `InputBar.module.css` and `HeroShell.module.css` |
| `ui-chat` and `ui-tool` | `AssistantMarkdown.module.css`, `ToolRow.module.css` and `ToolDetails.module.css` |
| `ui-approval` | `ApprovalPanel.module.css` and the ApprovalCard layout adapted in the conversation component |
| `ui-primitives` | `Button`, `UserMessageBubble`, their styles and selected glyphs from `icons/artwork.ts` |

Everpeace adapts class joining in the two primitives and supplies branding, component data, Markdown rendering and the interaction transport.
