vim.loader.enable()

require("config.options")
require("config.keymap")

vim.g.startup_bookmarks = {
  c = '~/.config/nvim/init.lua',
  n = '~/projects/npm/cli/',
}
