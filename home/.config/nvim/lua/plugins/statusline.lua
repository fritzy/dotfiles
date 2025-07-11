return {
  'echasnovski/mini.statusline',
  version = false,
  opts = {
    content = {
      inactive = function()
        local filename = MiniStatusline.section_filename({ trunc_width = 140 })
        return MiniStatusline.combine_groups({
          { hl = 'MiniStatuslineDevinfo',  strings = { '[%n]' } },
          '%<', -- Mark general truncate point
          { hl = 'MiniStatuslineFilename', strings = { filename } },
          '%=', -- End left alignment
        })
      end,
    },
  },
}
