return {
  "nvim-treesitter/nvim-treesitter",
  branch = 'master',
  -- must have tree-sitter package installed
  lazy = false,
  build = ":TSUpdate",

  config = function ()
    local configs = require("nvim-treesitter.configs")
    configs.setup({
      ensure_installed = {
        'c', 'lua', 'vim', 'vimdoc', 'query', 'javascript', 'bash',
        'c_sharp', 'cpp', 'desktop', 'diff', 'dockerfile',
        'html', 'css', 'json', 'markdown',
        'gdscript', 'gdshader', 'glsl',
        'git_config', 'git_rebase', 'gitattributes', 'gitcommit', 'gitignore',
        'python',
        'regex', 'ruby',
        'sql', 'ssh_config', 'terraform', 'toml', 'typescript', 'xml', 'yaml',
      },
      auto_install = true,
      sync_install = false,
      highlight = { enable = true },
      indent = { enable = true },
      incremental_selection = {
        enable = true,
        keymaps = {
          init_selection = "<Enter>",
          node_incremental = "<Enter>",
          scope_incremental = false,
          node_decremental = "<Backspace>",
        },
      },
    })
  end,
}
