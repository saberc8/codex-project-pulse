/* Shared form components: Tom Select 2.4.3 and Flatpickr 4.6.13. */
"use strict";
(() => {
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const chevron = (direction) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="${direction === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"}"/></svg>`;
  let selects = [],
    calendars = [],
    cleanup = [],
    scope = null;

  function field(id, label, control, optional) {
    return `<div class="form-field" data-field="${escape(id)}"><label class="form-label" id="${escape(id)}-label" for="${escape(id)}">${escape(label)}${optional ? '<span class="section-hint"> · 可选</span>' : ""}</label>${control}<p class="field-error" id="${escape(id)}-error" aria-live="polite"></p></div>`;
  }
  function optionsHTML(options, value) {
    return options
      .map(
        (item) =>
          `<option value="${escape(item.value)}" data-detail="${escape(item.detail || "")}" ${String(item.value) === String(value) ? "selected" : ""}>${escape(item.text)}</option>`,
      )
      .join("");
  }
  function textField({
    id,
    name,
    label,
    value = "",
    placeholder = "",
    required = false,
    autofocus = false,
    maxLength = 240,
  }) {
    return field(
      id,
      label,
      `<input class="form-input" id="${escape(id)}" name="${escape(name)}" value="${escape(value)}" placeholder="${escape(placeholder)}" maxlength="${maxLength}" ${required ? "required" : ""} ${autofocus ? "autofocus" : ""}>`,
    );
  }
  function selectField({
    id,
    name,
    label,
    options,
    value = "",
    placeholder = "请选择",
    searchable = false,
    required = false,
    optional = false,
    disabled = false,
  }) {
    return field(
      id,
      label,
      `<select class="form-input" id="${escape(id)}" name="${escape(name)}" data-ui-select data-searchable="${searchable}" data-placeholder="${escape(placeholder)}" ${required ? "required" : ""} ${disabled ? "disabled" : ""}>${optionsHTML(options, value)}</select>`,
      optional,
    );
  }
  function segmentedField({ id, name, label, options, value = "" }) {
    return field(
      id,
      label,
      `<div class="seg" role="radiogroup" aria-labelledby="${escape(id)}-label">${options
        .map(
          (item) =>
            `<label class="seg-item"><input type="radio" name="${escape(name)}" value="${escape(item.value)}" ${String(item.value) === String(value) ? "checked" : ""}><span>${escape(item.text)}</span></label>`,
        )
        .join("")}</div>`,
    );
  }
  function dateField({ id, name, label, value = "", optional = true }) {
    return field(
      id,
      label,
      `<input class="form-input date-input" id="${escape(id)}" name="${escape(name)}" type="text" value="${escape(value)}" placeholder="选择日期" autocomplete="off" data-ui-date>`,
      optional,
    );
  }
  function readOptions(select) {
    return [...select.options].map((option) => ({
      value: option.value,
      text: option.text,
      detail: option.dataset.detail || "",
      disabled: option.disabled,
    }));
  }
  function focusable(root, includePopups = true) {
    return [
      ...root.querySelectorAll(
        "button,input,select,textarea,a[href],[tabindex]",
      ),
    ].filter(
      (el) =>
        !el.disabled &&
        el.tabIndex >= 0 &&
        el.offsetParent !== null &&
        (includePopups || !el.closest(".ts-dropdown,.flatpickr-calendar")),
    );
  }
  function positionPopup(anchor, popup, preferredWidth, preferredHeight = 320) {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(
      preferredWidth || rect.width,
      window.innerWidth - 24,
    );
    const below = window.innerHeight - rect.bottom - 18;
    const above = rect.top - 18;
    const down = below >= preferredHeight || below >= above;
    const available = Math.max(80, down ? below : above);
    Object.assign(popup.style, {
      position: "fixed",
      width: `${width}px`,
      maxHeight: `${Math.min(preferredHeight, available)}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      bottom: "auto",
      margin: "0",
    });
    popup.style.top = `${down ? rect.bottom + 6 : Math.max(12, rect.top - popup.offsetHeight - 6)}px`;
  }
  function setError(input, message = "") {
    if (!input) return;
    const wrapper = input.closest(".form-field");
    const error = wrapper?.querySelector(".field-error");
    if (error) error.textContent = message;
    const visible = input.tomselect?.focus_node || input;
    wrapper?.toggleAttribute("data-invalid", Boolean(message));
    visible.setAttribute("aria-invalid", String(Boolean(message)));
    input.setAttribute("aria-invalid", String(Boolean(message)));
    if (message) visible.setAttribute("aria-describedby", `${input.id}-error`);
    else visible.removeAttribute("aria-describedby");
  }
  function validate(form) {
    const title = form.elements.namedItem("title");
    const project = form.elements.namedItem("projectId");
    setError(title, title.value.trim() ? "" : "请输入待办内容");
    setError(project, project.value ? "" : "请选择项目");
    const invalid = !title.value.trim()
      ? title
      : !project.value
        ? project
        : null;
    if (invalid)
      (invalid.tomselect?.focus_node || invalid).focus({ preventScroll: true });
    return !invalid;
  }
  function replaceOptions(select, options, value = "", disabled = false) {
    const widget = select.tomselect;
    widget.clear(true);
    widget.clearOptions();
    select.innerHTML = optionsHTML(options, value);
    widget.addOptions(options);
    widget.setValue(value, true);
    disabled ? widget.disable() : widget.enable();
    setError(select);
  }
  function listen(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    cleanup.push(() => target.removeEventListener(event, handler, options));
  }
  function openPicker() {
    const select = selects.find((item) => item.isOpen);
    if (select)
      return {
        anchor: select.focus_node,
        popup: select.dropdown,
        close: () => select.close(),
      };
    const date = calendars.find((item) => item.isOpen);
    if (date)
      return {
        anchor: date.input,
        popup: date.calendarContainer,
        close: () => {
          date.close();
          date.input.focus({ preventScroll: true });
        },
      };
    return null;
  }
  function reposition() {
    selects
      .filter((item) => item.isOpen)
      .forEach((item) => item.positionDropdown());
    calendars
      .filter((item) => item.isOpen)
      .forEach((item) =>
        positionPopup(item.input, item.calendarContainer, 300, 360),
      );
  }
  function destroy() {
    cleanup.forEach((remove) => remove());
    cleanup = [];
    selects.forEach((item) => item.destroy());
    calendars.forEach((item) => item.destroy());
    selects = [];
    calendars = [];
    scope = null;
  }
  function mount(root) {
    scope = root.querySelector(".dialog");
    if (!scope) return;
    root.querySelectorAll("[data-ui-select]").forEach((select) => {
      const searchable = select.dataset.searchable === "true";
      const widget = new TomSelect(select, {
        options: readOptions(select),
        plugins: searchable ? ["dropdown_input"] : [],
        controlInput: searchable
          ? '<input type="text" autocomplete="off">'
          : null,
        dropdownParent: scope,
        placeholder: select.dataset.placeholder,
        allowEmptyOption: !select.required,
        create: false,
        maxOptions: null,
        hideSelected: false,
        closeAfterSelect: true,
        openOnFocus: false,
        searchField: ["text", "detail"],
        sortField: [{ field: "$order", direction: "asc" }],
        render: {
          option: (data, esc) =>
            `<div class="ui-option"><span class="ui-option-copy"><span class="ui-option-title">${esc(data.text)}</span>${data.detail ? `<span class="ui-option-detail">${esc(data.detail)}</span>` : ""}</span><span class="ui-option-check" aria-hidden="true">✓</span></div>`,
          item: (data, esc) =>
            `<div><span class="ui-selected-text">${esc(data.text)}${data.detail ? `<span class="ui-selected-detail"> · ${esc(data.detail)}</span>` : ""}</span></div>`,
          no_results: () => '<div class="ui-select-empty">没有匹配项</div>',
        },
        onDropdownOpen() {
          this.positionDropdown();
        },
        onChange() {
          setError(select);
        },
      });
      widget.dropdown.classList.add("ui-select-popup");
      // Focus alone should not open a menu while tabbing through the form.
      // Tom Select's default click only focuses, so open explicitly on click.
      widget.onClick = () => {
        if (widget.isDisabled || widget.isReadOnly) return;
        if (widget.isOpen) widget.close();
        else {
          widget.focus();
          widget.open();
        }
      };
      const placeholder = widget.control.querySelector(".items-placeholder");
      if (placeholder) {
        placeholder.readOnly = true;
        placeholder.setAttribute("aria-hidden", "true");
      }
      widget.positionDropdown = () => {
        positionPopup(widget.control, widget.dropdown, null, 300);
        const searchHeight =
          widget.dropdown.querySelector(".dropdown-input-wrap")?.offsetHeight ||
          0;
        widget.dropdown_content.style.maxHeight = `${Math.max(48, parseFloat(widget.dropdown.style.maxHeight) - searchHeight - 10)}px`;
      };
      widget.focus_node.setAttribute("aria-required", String(select.required));
      if (widget.control_input) {
        widget.control_input.placeholder =
          select.id === "todo-project" ? "搜索项目" : "搜索会话";
        widget.control_input.setAttribute(
          "aria-label",
          widget.control_input.placeholder,
        );
      }
      listen(
        widget.focus_node,
        "keydown",
        (event) => {
          if (!widget.isOpen && ["Enter", " "].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            widget.open();
          }
        },
        true,
      );
      selects.push(widget);
    });
    root.querySelectorAll("[data-ui-date]").forEach((input) => {
      const calendar = flatpickr(input, {
        locale: flatpickr.l10ns.zh,
        dateFormat: "Y-m-d",
        ariaDateFormat: "Y年m月d日",
        disableMobile: true,
        animate: false,
        allowInput: false,
        clickOpens: false,
        monthSelectorType: "static",
        appendTo: scope,
        prevArrow: chevron("left"),
        nextArrow: chevron("right"),
        position: (instance) =>
          positionPopup(input, instance.calendarContainer, 300, 360),
        onReady(_dates, _value, instance) {
          const panel = instance.calendarContainer;
          panel.classList.add("ui-calendar");
          panel.id = `${input.id}-calendar`;
          panel.setAttribute("role", "dialog");
          panel.setAttribute("aria-label", "选择截止日期");
          [
            [instance.prevMonthNav, "上个月", -1],
            [instance.nextMonthNav, "下个月", 1],
          ].forEach(([button, label, step]) => {
            button.tabIndex = 0;
            button.setAttribute("role", "button");
            button.setAttribute("aria-label", label);
            listen(button, "keydown", (event) => {
              if (!["Enter", " "].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              instance.changeMonth(step);
            });
          });
          instance.currentYearElement.tabIndex = 0;
          input.setAttribute("role", "combobox");
          input.setAttribute("aria-haspopup", "dialog");
          input.setAttribute("aria-controls", panel.id);
          input.setAttribute("aria-expanded", "false");
          const footer = document.createElement("div");
          footer.className = "calendar-footer";
          footer.innerHTML =
            '<button type="button" data-date-today>今天</button><button type="button" data-date-clear>清除</button>';
          panel.appendChild(footer);
          footer
            .querySelector("[data-date-today]")
            .addEventListener("click", () => {
              instance.setDate(new Date(), true);
              instance.close();
              input.focus();
            });
          footer
            .querySelector("[data-date-clear]")
            .addEventListener("click", () => {
              instance.clear();
              instance.close();
              input.focus();
            });
        },
        onOpen() {
          input.setAttribute("aria-expanded", "true");
        },
        onClose() {
          input.setAttribute("aria-expanded", "false");
        },
        onChange() {
          setError(input);
        },
      });
      listen(input, "click", () => calendar.open());
      listen(
        input,
        "keydown",
        (event) => {
          if (["Enter", " ", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            calendar.open();
            (
              calendar.calendarContainer.querySelector(".selected") ||
              calendar.calendarContainer.querySelector(".today") ||
              calendar.daysContainer.querySelector(".flatpickr-day")
            ).focus();
          }
        },
        true,
      );
      calendars.push(calendar);
    });
    listen(
      document,
      "keydown",
      (event) => {
        const picker = openPicker();
        if (!picker) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          picker.close();
        } else if (
          event.key === "Tab" &&
          picker.popup.classList.contains("ts-dropdown")
        ) {
          const elements = focusable(scope, false);
          const index = elements.indexOf(picker.anchor);
          const next =
            elements[
              (index + (event.shiftKey ? -1 : 1) + elements.length) %
                elements.length
            ];
          event.preventDefault();
          event.stopImmediatePropagation();
          picker.close();
          next?.focus();
        }
      },
      true,
    );
    listen(window, "resize", reposition);
    listen(
      scope,
      "scroll",
      (event) => {
        if (!event.target.closest(".ts-dropdown,.flatpickr-calendar"))
          reposition();
      },
      true,
    );
  }
  window.PulseControls = {
    textField,
    selectField,
    segmentedField,
    dateField,
    mount,
    destroy,
    replaceOptions,
    validate,
    setError,
    focusable,
  };
})();
