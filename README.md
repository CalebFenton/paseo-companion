# paseo-companion

![Paseo companion: usage, pull requests, system](brand/hero.svg)

A [Paseo](https://paseo.sh) plugin with three screens, each opened from a row in the sidebar footer:

- **Usage**: every account's weekly limit, from omp's profiles and Paseo's own usage sources, ranked in the order to use them so no quota resets unused. It also adds pills to each session's composer and signals to the cards on Paseo's Usage screen.
- **Pull requests**: the pull requests that need your reply, review, re-review, or merge. Each workspace's sidebar row shows the same status for its pull request.
- **System**: CPU, memory, load, pressure, disk, network, and filesystems for each host.

## Install

The plugin runs from this checkout. It needs Paseo 0.17 or later, plus `gh` and `omp` signed in.

```sh
npm install
paseo plugin install "$PWD"
```

After a change, `paseo plugin reload paseo-companion` loads the new code.

`npm run icons` gives each Paseo project the icon listed in `scripts/project-icons.json`. That file is your own and is not committed; copy `scripts/project-icons.example.json` to start it.

## Development

[AGENTS.md](AGENTS.md) describes the layout, the checks, and the rules for working on the code.
