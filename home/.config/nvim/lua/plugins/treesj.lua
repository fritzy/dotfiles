return {
	"Wansmer/treesj",
	use_default_keymaps = false,
	dependencies = { "nvim-treesitter/nvim-treesitter" }, -- if you install parsers with `nvim-treesitter`
	config = function()
		require("treesj").setup({--[[ your config ]]
		})
	end,
}
