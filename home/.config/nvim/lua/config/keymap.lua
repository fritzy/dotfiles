vim.keymap.set("n", "-", "<cmd>Oil --float<CR>", { desc = "Open parent dir in oil" })
vim.keymap.set("n", "gl", function()
	vim.diagnostic.open_float()
end, { desc = "Open Diagnostics in Float" })
vim.keymap.set("n", "gb", "<C-t>", { desc = "[G]o [B]ack" })
vim.keymap.set("n", "<leader>cf", function()
	require("conform").format({
		lsp_format = "fallback",
	})
end, { desc = "Format current file" })
vim.keymap.set("n", "<leader>cc", function()
	vim.cmd("CopilotChatToggle")
	vim.cmd("wincmd =")
end, { desc = "Toggle CopilotChat" })

vim.keymap.set("n", "<leader>j", function()
	require("treesj").toggle()
end, { desc = "Toggle block line splits" })

local function map(mode, shortcut, command, desc)
	vim.keymap.set(mode, shortcut, command, { desc = desc })
end

local function nmap(shortcut, command, desc)
	map("n", shortcut, command, desc)
end

-- local function imap(shortcut, command)
--   map('i', shortcut, command)
-- end
--
-- buffer navigation shortcuts
nmap("<C-l>", "<C-W>l", "Jump to left split")
nmap("<C-h>", "<C-W>h", "Jump to right split")
nmap("<C-j>", "<C-W>j", "Jump to lower split")
nmap("<C-k>", "<C-W>k", "Jump to upper split")

-- indenting
map("v", ",", "<gv")
map("v", ".", ">gv")

-- buffer tabs
nmap("tj", ":tabfirst<CR>")
nmap("tl", ":tabnext<CR>")
nmap("th", ":tabprev<CR>")
nmap("tk", ":tablast<CR>")
nmap("tt", ":tabedit<CR>")
nmap("tmh", ":-tabm<CR>")
nmap("tml", ":+tabm<CR>")
nmap("td", ":tabclose<CR>")
nmap("tn", ":tabnew<CR>")

-- auto resize splits
nmap("<Leader>=", ":wincmd =<CR>")
nmap("<leader>n", ":set number! norelativenumber<CR>")
nmap("<leader>r", ":set rnu!<CR>")

-- just use the mouse
--nmap("<C-e>", ":vertical resize +1<CR>")
--nmap("<C-b>", ":vertical resize -1<CR>")
--nmap("<S-e>", ":resize resize -1<CR>")
--nmap("<S-b>", ":resize resize +1<CR>")

-- terminal esc
vim.cmd("tnoremap <Esc> <C-\\><C-n>")
