require("mason").setup()

require("mason-lspconfig").setup({
  ensure_installed = { "ts_ls", "eslint" }
})

local lspconfig = require('lspconfig')
lspconfig.ts_ls.setup({
  -- settings = {
  --   diagnostics = {
  --     ignoredCodes = {
  --       7016, -- Could not find a declaration file for module...
  --       80001, -- File is a CommonJS module ...
  --     },
  --   }
  -- },
  filetypes = {
    "javascript",
    "typescript"
  }
})

lspconfig.eslint.setup({})
