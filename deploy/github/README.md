# GitHub branch rules for the three RFPilot repos

`rulesets/<repo>.json` protects each repo's default branch (`main`):

- no direct pushes: changes land through a pull request;
- the CI jobs must pass on a branch that is up to date with `main`
  (backend: `Type-check, test, and build` and `Integration suite`; dashboard and admin:
  `Lint, type-check, test, and build`);
- one approving review, dismissed when new commits are pushed, and all review threads resolved;
- no force-push and no branch deletion;
- organization admins can bypass, but only through a pull request (for emergencies).

The Cloudflare Workers build on admin and the Vercel/Netlify previews are deliberately not
required: they depend on third-party configuration, and the admin Workers build already fails on `main`.

## Apply (needs repository admin; collaborators with push access get 404)

```bash
for repo in dxg-rfp-tool-backend dxg-rfp-tool-dashboard dxg-rfp-tool-admin; do
  gh api -X POST "repos/BayshoreCommunication/$repo/rulesets" \
    --input "deploy/github/rulesets/$repo.json"
done
```

Run it from this repo's root. To update later, find the id with
`gh api repos/BayshoreCommunication/<repo>/rulesets` and use `-X PUT .../rulesets/<id>`.

## Choices to confirm before applying

- **Required approvals = 1.** With a small team this means nobody merges their own PR alone.
  Set `required_approving_review_count` to `0` to keep "PR + green CI" without a second person.
- **Up-to-date branch required** (`strict_required_status_checks_policy`). Safer, but every PR must
  be rebased after another merges. Set it to `false` if that slows the team down.
- If a CI job is renamed, update its `context` here in the same PR, or merges will block.
