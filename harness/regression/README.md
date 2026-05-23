# Regression Reports

Each run of `npm run test:regression` overwrites `last-run.json` with a JSON
report. The file is gitignored to avoid noise; if you want to keep a snapshot,
copy it into a dated filename in this directory.

```
harness/regression/
├── README.md          # this file
├── last-run.json      # generated, gitignored
└── 20260516-1700.json # example archived snapshot (created manually)
```
