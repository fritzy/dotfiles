local grep_opts = {
	"rg",
	"--vimgrep",
	"--hidden",
	"--follow",
	"--glob",
	'"!**/.git/*"',
	"--column",
	"--line-number",
	"--no-heading",
	"--color=always",
	"--smart-case",
	"--max-columns=4096",
	"-e",
}

return {
	"ibhagwan/fzf-lua",
	dependencies = { "echasnovski/mini.icons" },
	opts = {
		grep = {
			cwd_prompt = false,
			--prompt = Utils.icons.misc.search .. " ",
			input_prompt = "Grep For ❯ ",
			cmd = table.concat(grep_opts, " "),
			hidden = true,
			follow = true,
		},
	},
	keys = {
		{
			"<leader>ff",
			function()
				require("fzf-lua").files()
			end,
			desc = "Find File (fzf)",
		},
		{
			"<leader>fg",
			function()
				require("fzf-lua").live_grep()
			end,
			desc = "Find Grep CWD (fzf)",
		},
		{
			"<leader>fb",
			function()
				require("fzf-lua").buffers()
			end,
			desc = "Find Grep CWD (fzf)",
		},
		{
			"<leader>fc",
			function()
				require("fzf-lua").files({ cwd = vim.fn.stdpath("config") })
			end,
			desc = "Find File (fzf)",
		},
	},
	config = function()
		vim.ui.select = require('fzf-lua').register_ui_select()
	end,
}
