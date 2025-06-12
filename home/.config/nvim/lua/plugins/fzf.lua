return {
  'ibhagwan/fzf-lua',
  dependencies = { 'echasnovski/mini.icons' },
  opts = {},
  keys = {
    {
      '<leader>ff',
      function() require('fzf-lua').files() end,
      desc = 'Find File (fzf)'
    },
    {
      '<leader>fg',
      function() require('fzf-lua').live_grep() end,
      desc = 'Find Grep CWD (fzf)'
    },
    {
      '<leader>fc',
      function() require('fzf-lua').files({cwd=vim.fn.stdpath("config")}) end,
      desc = 'Find File (fzf)'
    },
  }
}
