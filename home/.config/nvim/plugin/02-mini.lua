vim.pack.add({
  { src = 'https://github.com/echasnovski/mini.icons', version = vim.version.range('*') },
  'https://github.com/echasnovski/mini.statusline',
})

require('mini.icons').setup({ style = 'glyph' })

require('mini.statusline').setup({
  content = {
    inactive = function()
      local filename = MiniStatusline.section_filename({ trunc_width = 140 })
      return MiniStatusline.combine_groups({
        { hl = 'MiniStatuslineDevinfo',  strings = { '[%n]' } },
        '%<',
        { hl = 'MiniStatuslineFilename', strings = { filename } },
        '%=',
      })
    end,
  },
})
