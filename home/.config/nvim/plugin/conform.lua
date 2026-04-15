vim.pack.add({ 'https://github.com/stevearc/conform.nvim' })

require('conform').setup({
  formatters_by_ft = {
    lua = { 'stylua' },
    python = { 'flake8', 'isort', 'ruff', lsp_format = 'fallback' },
    rust = { 'rustfmt', lsp_format = 'fallback' },
    javascript = { 'eslint_d', 'prettier', stop_after_first = true },
    typescript = { 'prettier', 'eslint_d' },
  },
})
