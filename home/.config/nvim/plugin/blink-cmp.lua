-- blink.cmp uses a Rust fuzzy matcher. If cargo is available it will be built
-- via the PackChanged hook below; otherwise the Lua fallback is used automatically
-- (controlled by fuzzy.implementation = "prefer_rust_with_warning").
vim.api.nvim_create_autocmd('PackChanged', { callback = function(ev)
  local name, kind = ev.data.spec.name, ev.data.kind
  if name == 'blink.cmp' and (kind == 'install' or kind == 'update') then
    if not ev.data.active then vim.cmd.packadd('blink.cmp') end
    local path = vim.fn.stdpath('data') .. '/site/pack/core/opt/blink.cmp'
    vim.fn.jobstart({ 'cargo', 'build', '--release', '--manifest-path', path .. '/Cargo.toml' }, {
      cwd = path,
      on_exit = function(_, code)
        if code ~= 0 then
          vim.notify('blink.cmp: cargo build failed, using Lua fallback', vim.log.levels.WARN)
        end
      end,
    })
  end
end })

vim.pack.add({
  { src = 'https://github.com/saghen/blink.compat', version = vim.version.range('2.x') },
  'https://github.com/rafamadriz/friendly-snippets',
  'https://github.com/moyiz/blink-emoji.nvim',
  { src = 'https://github.com/saghen/blink.cmp', version = vim.version.range('1.x') },
})

require('blink.compat').setup()

require('blink.cmp').setup({
  keymap = { preset = 'default' },
  appearance = { nerd_font_variant = 'mono' },
  completion = { documentation = { auto_show = true } },
  signature = { enabled = true },
  sources = {
    default = { 'lsp', 'path', 'snippets', 'buffer', 'emoji' },
    providers = {
      emoji = {
        module = 'blink-emoji',
        name = 'Emoji',
        score_offset = 15,
        opts = {
          insert = true,
          trigger = function()
            return { ':' }
          end,
        },
        should_show_items = function()
          return vim.tbl_contains({ 'gitcommit', 'markdown' }, vim.o.filetype)
        end,
      },
    },
  },
  fuzzy = { implementation = 'prefer_rust_with_warning' },
})
