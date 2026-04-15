vim.api.nvim_create_autocmd('PackChanged', { callback = function(ev)
  local name, kind = ev.data.spec.name, ev.data.kind
  if name == 'nvim-treesitter' and (kind == 'install' or kind == 'update') then
    if not ev.data.active then vim.cmd.packadd('nvim-treesitter') end
    vim.cmd('TSUpdate')
  end
end })

vim.pack.add({
  'https://github.com/nvim-treesitter/nvim-treesitter',
  'https://github.com/nvim-treesitter/nvim-treesitter-textobjects',
})

require('nvim-treesitter').setup({
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
      init_selection = '<Enter>',
      node_incremental = '<Enter>',
      scope_incremental = false,
      node_decremental = '<Backspace>',
    },
  },
  textobjects = {
    swap = {
      enable = true,
      swap_next = { ['<leader>a'] = '@parameter.inner' },
      swap_previous = { ['<leader>A'] = '@parameter.inner' },
    },
    select = {
      enable = true,
      lookahead = true,
      keymaps = {
        ['af'] = '@function.outer',
        ['if'] = '@function.inner',
        ['ac'] = '@class.outer',
        ['aC'] = '@comment.outer',
        ['iC'] = '@comment.outer',
        ['ic'] = { query = '@class.inner', desc = 'Select inner part of a class region' },
        ['as'] = { query = '@local.scope', query_group = 'locals', desc = 'Select language scope' },
      },
      selection_modes = {
        ['@parameter.outer'] = 'v',
        ['@function.outer'] = 'V',
        ['@class.outer'] = '<c-v>',
      },
      include_surrounding_whitespace = true,
    },
  },
})
