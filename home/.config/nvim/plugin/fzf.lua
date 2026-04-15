vim.pack.add({ 'https://github.com/ibhagwan/fzf-lua' })

local grep_opts = {
  'rg',
  '--vimgrep',
  '--hidden',
  '--follow',
  '--glob',
  '"!**/.git/*"',
  '--column',
  '--line-number',
  '--no-heading',
  '--color=always',
  '--smart-case',
  '--max-columns=4096',
  '-e',
}

require('fzf-lua').setup({
  grep = {
    cwd_prompt = false,
    input_prompt = 'Grep For ❯ ',
    cmd = table.concat(grep_opts, ' '),
    hidden = true,
    follow = true,
  },
})

require('fzf-lua').register_ui_select()

vim.keymap.set('n', '<leader>ff', function() require('fzf-lua').files() end, { desc = 'Find File (fzf)' })
vim.keymap.set('n', '<leader>fr', function() require('fzf-lua').oldfiles() end, { desc = 'Recent Files (fzf)' })
vim.keymap.set('n', '<leader>fg', function() require('fzf-lua').live_grep() end, { desc = 'Find Grep CWD (fzf)' })
vim.keymap.set('n', '<leader>fb', function() require('fzf-lua').buffers() end, { desc = 'Find Buffer (fzf)' })
vim.keymap.set('n', '<leader>fc', function()
  require('fzf-lua').files({ cwd = vim.fn.stdpath('config') })
end, { desc = 'Find Config File (fzf)' })
