return {
  'rktjmp/lush.nvim',
  'metalelf0/jellybeans-nvim',
  'williamboman/mason.nvim',
  'williamboman/mason-lspconfig.nvim',
  'neovim/nvim-lspconfig',
  {
    'echasnovski/mini.icons',
    version = '*',
    init = function()
      require('mini.icons').setup(
        {
          style = 'glyph',
        }
      )
    end,
  },
  { "nvim-tree/nvim-web-devicons", opts = {} },
  {
    "folke/snacks.nvim",
    priority = 1000,
    lazy = false,
    ---@type snacks.Config
    opts = {
      -- your configuration comes here
      -- or leave it empty to use the default settings
      -- refer to the configuration section below
      bigfile = { enabled = true },
      dashboard = {
        enabled = true,
        --pane_gap = 4,
        width = 65,
        sections = {
          {
            pane = 1,
            width = 65,
            height = 12,
            padding = {1,1},
            section = "terminal",
            cmd = "cat ~/.config/nvim/ansi/enterprise.ansi"
          },
          {
            pane = 1,
            width = 67,
            icon = " ",
            title = "Recent Files",
            section = "recent_files",
            limit = 10,
            indent = 2,
            padding = 1,
          },
          {
            pane = 1,
            section = "keys",
            gap = 0,
            padding = 1,
          },
          {
            pane = 1,
            section = "startup",
            padding = 1,
          },
          {
            pane = 2,
            enabled = function ()
              return in_git
            end,
            icon = " ",
            desc = "Browse Repo",
            padding = 1,
            key = "b",
            action = function()
              Snacks.gitbrowse()
            end,
          },
          function()
            local in_git = Snacks.git.get_root() ~= nil
            local cmds = {
              {
                title = "Open Issues",
                cmd = "gh issue list -L 3",
                key = "i",
                action = function()
                  vim.fn.jobstart("gh issue list --web", { detach = true })
                end,
                icon = " ",
                height = 7,
              },
              {
                icon = " ",
                title = "Open PRs",
                cmd = "gh pr list -L 3",
                key = "P",
                action = function()
                  vim.fn.jobstart("gh pr list --web", { detach = true })
                end,
                height = 7,
              },
              {
                icon = " ",
                title = "Git Status",
                cmd = "git --no-pager diff --stat -B -M -C",
                height = 10,
              },
            }
            return vim.tbl_map(function(cmd)
              return vim.tbl_extend("force", {
                pane = 2,
                section = "terminal",
                enabled = in_git,
                padding = 1,
                ttl = 5 * 60,
                indent = 3,
              }, cmd)
            end, cmds)
          end,
        },
      },
      indent = { enabled = true },
      input = { enabled = true },
      picker = { enabled = true },
      notifier = { enabled = true },
      quickfile = { enabled = true },
      scroll = { enabled = true },
      statuscolumn = { enabled = true },
      words = { enabled = true },
    },

  },
}
