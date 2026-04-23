vim.pack.add({
  'https://github.com/nvim-lua/plenary.nvim',
  'https://github.com/greggh/claude-code.nvim',
})

require('claude-code').setup({
  window = { position = 'vertical' },
  keymaps = {
    window_navigation = false,
    scrolling = true,
    toggle = {
      normal = '<C-,>',
      terminal = '<C-,>',
      variants = {
        continue = '<leader>cC',
        verbose = '<leader>cV',
      },
    },
  },
})
