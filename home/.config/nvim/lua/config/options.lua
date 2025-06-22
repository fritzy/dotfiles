vim.g.mapleader = ","
vim.g.localmapleader = "//"

-- some of this taken from nvim-lua/kickstart.nvim/init.lua
vim.g.have_nerd_font = true

vim.o.number = true
vim.o.relativenumber = true

vim.o.mouse = "a"

-- we already have the mode in the statusline plugin
vim.o.showmode = false

vim.schedule(function()
	--vim.o.clipboard = "unnamedplus"
	vim.cmd("set clipboard=unnamed,unnamedplus")
end)

vim.o.breakindent = true
vim.o.undofile = true

-- vim split does left and top by default
vim.o.splitright = true
vim.o.splitbelow = true

-- Case-insensitive searching UNLESS \C or one or more capital letters in the search term
vim.o.ignorecase = true
vim.o.smartcase = true

vim.o.list = true
vim.opt.listchars = { tab = "» ", trail = "·", nbsp = "␣" }

-- Minimal number of screen lines to keep above and below the cursor.
vim.o.scrolloff = 10

vim.o.shiftwidth = 2
vim.o.tabstop = 2
vim.o.softtabstop = 2

vim.o.expandtab = true
vim.o.smarttab = true
vim.o.smartindent = true
vim.o.autoindent = true
