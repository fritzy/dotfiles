vim.keymap.set('n', '-', '<cmd>Oil --float<CR>', { desc="Open parent dir in oil" })
vim.keymap.set('n', 'gl', function() vim.diagnostic.open_float() end, { desc= "Open Diagnostics in Float"})
vim.keymap.set('n', 'gb', '<C-t>', { desc= "[G]o [B]ack"})

local function map(mode, shortcut, command)
  vim.api.nvim_set_keymap(
    mode, shortcut, command, { noremap = true, silent = true }
  )
end

local function nmap(shortcut, command)
  map('n', shortcut, command)
end

-- local function imap(shortcut, command)
--   map('i', shortcut, command)
-- end
--
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
