return {
  'metalelf0/jellybeans-nvim',
  dependencies = {'rktjmp/lush.nvim'},
  config = function()
    vim.opt.termguicolors = true
    vim.opt.background = 'dark'
    vim.cmd('colorscheme jellybeans-nvim')
  end,
}
