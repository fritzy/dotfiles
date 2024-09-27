-- shortcuts
vim.g.mapleader = ","

require("config.lazy")
require("plugin_config.lsp_config")


vim.opt.termguicolors = true
vim.opt.background = 'dark'
--vim.opt.ayucolor = "mirage"
vim.cmd('colorscheme jellybeans-nvim')
vim.g.startup_bookmarks = {
 c = '~/.config/nvim/init.lua',
 n = '~/projects/npm/cli/',
}

if vim.g.neovide then
  vim.o.guifont = "Cascadia Code PL:h16"
end

-- vim.opt.backspace = 2
-- for js
vim.opt.shiftwidth = 2
vim.opt.softtabstop = 2
vim.opt.expandtab = true

-- on macos
vim.opt.clipboard = 'unnamedplus'

-- show invisible
vim.opt.list = true
vim.opt.smartindent = true


local function map(mode, shortcut, command)
  vim.api.nvim_set_keymap(
    mode, shortcut, command, { noremap = true, silent = true }
  )
end

local function nmap(shortcut, command)
  map('n', shortcut, command)
end

local function imap(shortcut, command)
  map('i', shortcut, command)
end

-- buffer navigation shortcuts
nmap('<C-l>', '<C-W>l')
nmap('<C-h>', '<C-W>h')
nmap('<C-j>', '<C-W>j')
nmap('<C-k>', '<C-W>k')

-- indenting
map('v', ',', '<gv')
map('v', '.', '>gv')

-- buffer tabs
nmap('tj', ':tabfirst<CR>')
nmap('tl', ':tabnext<CR>')
nmap('th', ':tabprev<CR>')
nmap('tk', ':tablast<CR>')
nmap('tt', ':tabedit<CR>')
nmap('tmh', ':-tabm<CR>')
nmap('tml', ':+tabm<CR>')
nmap('td', ':tabclose<CR>')
nmap('tn', ':tabnew<CR>')

-- auto resize splits
nmap('<Leader>=', ':wincmd =<CR>')
nmap('<leader>n', ':set number! norelativenumber<CR>')
nmap('<leader>r', ':set rnu!<CR>')

nmap('<C-e>', ':vertical resize +1<CR>')
nmap('<C-b>', ':vertical resize -1<CR>')
nmap('<S-e>', ':resize resize -1<CR>')
nmap('<S-b>', ':resize resize +1<CR>')

-- terminal esc
vim.cmd('tnoremap <Esc> <C-\\><C-n>')
