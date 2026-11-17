# Profile dashboard

The dashboard images in the profile README are published to the `output` branch by [Generate Profile Analytics & Contribution Snake](workflows/snake.yml).

## First run and refresh

The workflow runs on pushes that change its generator, workflow, or README, on a daily schedule, and on demand. To seed or refresh the images manually, open **Actions**, select **Generate Profile Analytics & Contribution Snake**, and choose **Run workflow**. The workflow needs the repository's standard `GITHUB_TOKEN` with contents write permission, which is declared in the workflow. No personal access token or secret setup is required.

After a successful run, these files are published on the `output` branch:

- `profile-dashboard.svg`
- `contribution-heatmap.svg`
- `github-contribution-grid-snake-dark.svg`

GitHub profile contributions and account metrics are based on public data. Private activity is excluded.

## Activity score

The custom XP score is a reproducible activity measure, not an official GitHub ranking or a measure of engineering skill. The generator calculates XP as:

`repositories × 100 + followers × 20 + stars × 10 + forks × 5 + last-year contributions × 2 + pull-request contributions × 25`

The dashboard reports the level associated with that score and the progress toward the next level. Milestones are shown as unlocked only when public GitHub data verifies them.
