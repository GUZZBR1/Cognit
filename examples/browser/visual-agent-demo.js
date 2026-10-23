const result = document.querySelector('#result');
for (const button of document.querySelectorAll('[data-choice]')) {
  button.addEventListener('click', () => {
    result.textContent = button.dataset.choice === 'square' ? 'Selection accepted.' : 'Selection not accepted.';
  });
}
