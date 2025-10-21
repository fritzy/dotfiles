return {
  'github/copilot.vim',
  config = function()
    vim.g.copilot_node_command = 'nvm exec 22 node'
    vim.g.copilot_filetypes = {
      ['*'] = false, -- Disable Copilot for all file types
    }
    vim.keymap.set("n", "<leader>cp", function()
      vim.b.copilot_enabled = not vim.b.copilot_enabled
      print("Copilot is now " .. (vim.b.copilot_enabled and "enabled" or "disabled"))
    end, { desc = "Toggle Copilot" })
    --vim.g.copilot_no_tab_map = true -- Disable default tab mapping
    --vim.api.nvim_set_keymap('i', '<C-j>', 'copilot#Accept("<CR>")', { expr = true, silent = true })
  end,
}
