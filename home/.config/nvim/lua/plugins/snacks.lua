return {
  "folke/snacks.nvim",
  priority = 1000,
  lazy = false,
  ---@type snacks.Config
  opts = {
    -- your configuration comes here
    -- or leave it empty to use the default settings
    -- refer to the configuration section below
    bigfile = { enabled = false },
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
          cmd = "cat ~/.config/nvim/ansi/enterprise.ansi; sleep .1"
        },
        {
          pane = 1,
          width = 67,
          icon = " ",
          title = "Recent Files",
          section = "recent_files",
          limit = 5,
          indent = 2,
          padding = 1,
        },
        {
          pane = 1,
          section = "keys",
          gap = 0,
          padding = 1,
        },
        --[[
        {
          pane = 2,
          width = 65,
          height = 6,
          padding = {1 , 1},
          enabled = function ()
            return Snacks.git.get_root() ~= nil
          end,
          section = "terminal",
          cmd = "cat ~/.config/nvim/ansi/github.ansi; sleep .1"
        },
        --]]
        {
          pane = 1,
          enabled = function ()
            return Snacks.git.get_root() ~= nil
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
              icon = " ",
              title = "Git Status",
              cmd = "git --no-pager diff --stat -B -M -C; sleep .1",
              height = 5,
            },
            --[[
            {
              title = "Open Issues",
              cmd = "gh issue list -L 3; sleep .1",
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
              cmd = "gh pr list -L 3; sleep .1",
              key = "P",
              action = function()
                vim.fn.jobstart("gh pr list --web", { detach = true })
              end,
              height = 7,
            },
            --]]
          }
          return vim.tbl_map(function(cmd)
            return vim.tbl_extend("force", {
              pane = 1,
              section = "terminal",
              enabled = in_git,
              padding = 1,
              ttl = 5 * 60,
              indent = 3,
            }, cmd)
          end, cmds)
        end,
        {
          pane = 1,
          section = "startup",
          padding = 1,
        },
      },
    },
    indent = { enabled = true },
    input = { enabled = true },
    picker = { enabled = true },
    notifier = { enabled = false },
    quickfile = { enabled = true },
    scroll = { enabled = false },
    statuscolumn = { enabled = false },
    words = { enabled = true },
  },
}
