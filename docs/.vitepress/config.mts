import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Sluice',
  description: 'Nothing merges until the checks open the gate.',
  srcExclude: ['GOAL.md'],
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'Quickstart', link: '/quickstart' },
      { text: 'Guide', link: '/guide/gate' },
      { text: 'Reference', link: '/reference/cli' },
    ],
    sidebar: [
      {
        text: 'Start',
        items: [
          { text: 'What is Sluice', link: '/' },
          { text: 'Quickstart (<10 min)', link: '/quickstart' },
          { text: 'Concepts', link: '/concepts' },
          { text: 'Languages (TS, Go, .NET)', link: '/languages' },
          { text: 'Field trials', link: '/field-trials' },
        ],
      },
      {
        text: 'Guide',
        items: [
          { text: 'Gate (north star)', link: '/guide/gate' },
          { text: 'Sandbox & fakes', link: '/guide/sandbox' },
          { text: 'Evidence & replay', link: '/guide/evidence' },
          { text: 'Agents (MCP, CLI)', link: '/guide/agents' },
          { text: 'Bench', link: '/guide/bench' },
          { text: 'Policy & rules', link: '/guide/policy' },
          { text: 'Coordination', link: '/guide/coordination' },
          { text: 'Campaigns', link: '/guide/campaigns' },
          { text: 'GitHub', link: '/guide/github' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'sluice.yaml', link: '/config' },
          { text: 'Plugin API', link: '/plugin-api' },
          { text: 'Architecture decisions', link: '/adr/0001-architecture' },
        ],
      },
    ],
  },
});
