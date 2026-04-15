vim.api.nvim_create_autocmd('PackChanged', { callback = function(ev)
  local name, kind = ev.data.spec.name, ev.data.kind
  if name == 'CopilotChat.nvim' and (kind == 'install' or kind == 'update') then
    if not ev.data.active then vim.cmd.packadd('CopilotChat.nvim') end
    local path = vim.fn.stdpath('data') .. '/site/pack/core/opt/CopilotChat.nvim'
    vim.fn.jobstart({ 'make', 'tiktoken' }, { cwd = path })
  end
end })

vim.pack.add({
  'https://github.com/github/copilot.vim',
  'https://github.com/CopilotC-Nvim/CopilotChat.nvim',
})

vim.g.copilot_node_command = 'nvm exec 22 node'
vim.g.copilot_filetypes = { ['*'] = false }
vim.keymap.set('n', '<leader>cp', function()
  vim.b.copilot_enabled = not vim.b.copilot_enabled
  print('Copilot is now ' .. (vim.b.copilot_enabled and 'enabled' or 'disabled'))
end, { desc = 'Toggle Copilot' })

require('CopilotChat').setup()
