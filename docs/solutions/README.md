# Solutions Directory

Bug documentation and prevention patterns for Family Capital Ledger.
Template adopted from Hanzi Dojo.

## Structure

```
docs/solutions/
├── README.md              # This file
├── database-issues/       # SQL, RPC, migration bugs
└── process-learnings/     # Development process issues
```

## Template for New Issues

```markdown
---
title: "Descriptive Title"
slug: kebab-case-slug
category: database-issues | process-learnings
tags: [relevant, tags]
severity: critical | high | medium | low
component: affected-component
date_solved: YYYY-MM-DD
---

# Title

## Problem Symptom
What was observed?

## Root Cause
Why did it happen?

## Solution
The fix applied.

## Prevention Strategies
How to avoid this in the future.
```
