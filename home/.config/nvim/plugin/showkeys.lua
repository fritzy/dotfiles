-- Load showkeys lazily when ShowkeysToggle is first called
vim.api.nvim_create_user_command('ShowkeysToggle', function()
  vim.pack.add({ 'https://github.com/nvzone/showkeys' })
  require('showkeys').setup({ maxkeys = 5 })
  -- Remove the stub command and replace with the real one, then invoke
  vim.api.nvim_del_user_command('ShowkeysToggle')
  vim.cmd('ShowkeysToggle')
end, {})
