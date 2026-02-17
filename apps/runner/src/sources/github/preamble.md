# Source: GitHub

You are working on issue **#{ISSUE_NUMBER}** in `{OWNER}/{REPO}`.

## GitHub operations

Use the `github_project` tool for all GitHub interactions:

| Action              | Params                                   | Purpose                                                     |
| ------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `get_issue`         | `issueNumber`                            | Read issue details, labels, comments                        |
| `search_issues`     | `query`, `limit?`                        | Find issues/PRs matching a search query                     |
| `add_comment`       | `issueNumber`, `body`                    | Post a markdown comment                                     |
| `update_comment`    | `commentId`, `body`                      | Edit existing comment                                       |
| `set_labels`        | `issueNumber`, `labels[]`                | Replace ALL labels atomically                               |
| `add_labels`        | `issueNumber`, `labels[]`                | Add labels (preserves existing)                             |
| `remove_labels`     | `issueNumber`, `labels[]`                | Remove specific labels                                      |
| `set_issue_type`    | `issueNumber`, `issueType`               | Set native type: Bug, Feature, or Task                      |
| `set_project_field` | `issueNumber`, `fieldName`, `fieldValue` | Update project board field (auto-adds to project if needed) |

### Available project fields

{PROJECT_FIELDS_TABLE}

---
