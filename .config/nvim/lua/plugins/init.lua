return {
  'rktjmp/lush.nvim',
  'metalelf0/jellybeans-nvim',
  'williamboman/mason.nvim',
  'williamboman/mason-lspconfig.nvim',
  'neovim/nvim-lspconfig',
  --'jose-elias-alvarez/null-ls',
  --'MunifTanjim/eslint.nvim',
  {
    "startup-nvim/startup.nvim",
    dependencies = { "nvim-telescope/telescope.nvim", "nvim-lua/plenary.nvim", "nvim-telescope/telescope-file-browser.nvim" },
    config = function()
      require "startup".setup({ theme = "startify" })
    end
  },
}
